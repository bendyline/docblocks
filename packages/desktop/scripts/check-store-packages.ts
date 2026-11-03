/**
 * Verify store submission packages after electron-builder writes them, before
 * they are attached to the private draft release:
 *
 *   npx tsx scripts/check-store-packages.ts msix [artifacts-dir]
 *   npx tsx scripts/check-store-packages.ts mas <build-number> [artifacts-dir]
 *
 * `msix` reads each architecture's AppxManifest.xml (Windows' bsdtar reads the
 * package's zip container). `mas` needs macOS: it checks the installer and app
 * signatures against the embedded provisioning profile's team, the app and
 * helper entitlements, Info.plist, and the helper set, then runs the app's own
 * runtime verifier over the relocated Gezel engines. Policy lives in
 * store-package-policy.ts.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { verifyMasNativePayload } from '../main/ai/gezel-mas-native.js';
import {
  MSIX_ARCHITECTURES,
  appxManifestViolations,
  installerSignatureViolations,
  masAppEntitlementViolations,
  masChildEntitlementViolations,
  masHelperViolations,
  masInfoViolations,
  masProfileViolations,
  type BundleEntry,
} from './store-package-policy.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version: string = JSON.parse(
  readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
).version;
const failures: string[] = [];

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function report(subject: string, violations: readonly string[]): void {
  for (const violation of violations) failures.push(`${subject}: ${violation}`);
}

function run(
  command: string,
  args: readonly string[],
): { ok: boolean; stdout: string; output: string } {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`${command} could not be started: ${result.error.message}`);
  const stdout = result.stdout ?? '';
  return { ok: result.status === 0, stdout, output: `${stdout}${result.stderr ?? ''}` };
}

function artifacts(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    fail(`No packaged artifacts directory at ${directory}.`);
  }
}

function checkMsix(artifactsDir: string): void {
  const config = yaml.load(readFileSync(path.join(packageRoot, 'electron-builder.yml'), 'utf8'));
  const appx = (config as { appx?: Record<string, string | undefined> }).appx ?? {};
  const { identityName, publisher, displayName, publisherDisplayName } = appx;
  if (!identityName || !publisher || !displayName || !publisherDisplayName)
    fail('electron-builder.yml must define the complete Partner Center appx identity.');
  // GNU tar, which Git for Windows can put first on PATH, cannot read zip.
  const tar =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  const names = artifacts(artifactsDir);
  for (const architecture of MSIX_ARCHITECTURES) {
    const matches = names.filter((name) =>
      ['appx', 'msix'].some((extension) => name.endsWith(`-win-${architecture}.${extension}`)),
    );
    if (matches.length !== 1) {
      failures.push(
        `Microsoft Store ${architecture}: expected one package, found ${matches.length}`,
      );
      continue;
    }
    const extracted = run(tar, ['-xOf', path.join(artifactsDir, matches[0]), 'AppxManifest.xml']);
    if (!extracted.ok) fail(`Cannot read ${matches[0]}'s manifest:\n  ${extracted.output.trim()}`);
    report(
      matches[0],
      appxManifestViolations(extracted.stdout, {
        name: identityName,
        publisher,
        displayName,
        publisherDisplayName,
        version,
        architecture,
      }),
    );
    process.stdout.write(`  ${matches[0]}: identity, architecture and version checked\n`);
  }
}

function plistJson(file: string): Record<string, unknown> {
  const converted = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]);
  if (!converted.ok) fail(`Cannot read ${file}:\n  ${converted.output.trim()}`);
  return JSON.parse(converted.stdout);
}

async function entitlementsOf(file: string, work: string): Promise<Record<string, unknown>> {
  const shown = run('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', file]);
  if (!shown.ok) fail(`Cannot read entitlements of ${file}:\n  ${shown.output.trim()}`);
  if (!shown.stdout.trim()) return {};
  const plist = path.join(work, `${path.basename(file)}-${Date.now()}.plist`);
  await writeFile(plist, shown.stdout);
  return plistJson(plist);
}

/** A provisioning profile carries dates and data, which plutil cannot render as JSON. */
function profileFields(plist: string): Record<string, unknown> {
  const field = (key: string, format: 'json' | 'raw') => {
    const extracted = run('/usr/bin/plutil', ['-extract', key, format, '-o', '-', plist]);
    if (!extracted.ok) return undefined;
    return format === 'json' ? JSON.parse(extracted.stdout) : extracted.stdout.trim();
  };
  return {
    TeamIdentifier: field('TeamIdentifier', 'json'),
    Platform: field('Platform', 'json'),
    ProvisionedDevices: field('ProvisionedDevices', 'json'),
    ProvisionsAllDevices: field('ProvisionsAllDevices', 'json'),
    Entitlements: field('Entitlements', 'json'),
    ExpirationDate: field('ExpirationDate', 'raw'),
  };
}

function findFiles(directory: string, predicate: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    if (predicate(name)) found.push(file);
    else if (!name.endsWith('.app') && statSync(file).isDirectory())
      found.push(...findFiles(file, predicate));
  }
  return found;
}

async function checkMas(buildNumber: string, artifactsDir: string): Promise<void> {
  if (process.platform !== 'darwin') fail('Mac App Store packages can only be verified on macOS.');
  if (!/^[1-9][0-9]{0,8}$/u.test(buildNumber)) fail('Supply the positive integer build number.');
  const names = artifacts(artifactsDir);
  const masDirs = names
    .filter((name) => /^mas-(?!dev)/u.test(name))
    .map((name) => path.join(artifactsDir, name));
  const apps = masDirs.flatMap((dir) => findFiles(dir, (name) => name.endsWith('.app')));
  // electron-builder writes the installer beside the app; accept the root too.
  const pkgs = [
    ...names.filter((name) => name.endsWith('.pkg')).map((name) => path.join(artifactsDir, name)),
    ...masDirs.flatMap((dir) => findFiles(dir, (name) => name.endsWith('.pkg'))),
  ];
  if (apps.length !== 1 || pkgs.length !== 1)
    fail(
      `Expected one MAS app and one .pkg under ${artifactsDir}; found ${apps.length} and ${pkgs.length}.`,
    );
  const [app] = apps;
  const [pkg] = pkgs;
  const work = await mkdtemp(path.join(os.tmpdir(), 'docblocks-store-check-'));
  try {
    const verified = run('/usr/bin/codesign', [
      '--verify',
      '--deep',
      '--strict',
      '--verbose=2',
      app,
    ]);
    if (!verified.ok)
      failures.push(`${app}: codesign verification failed\n${verified.output.trim()}`);

    const profilePath = path.join(app, 'Contents', 'embedded.provisionprofile');
    const decoded = path.join(work, 'profile.plist');
    if (!run('/usr/bin/security', ['cms', '-D', '-i', profilePath, '-o', decoded]).ok)
      fail(`${app} has no readable embedded.provisionprofile.`);
    const profile = masProfileViolations(profileFields(decoded), new Date());
    report('provisioning profile', profile.violations);
    const team = profile.team;
    // Every remaining check compares against this team.
    if (team === null) fail(`Store package policy failed:\n  ${failures.join('\n  ')}`);

    const signer = /^TeamIdentifier=(.+)$/mu.exec(
      run('/usr/bin/codesign', ['-dv', app]).output,
    )?.[1];
    if (signer !== team)
      failures.push(`${app}: signed by team ${signer ?? 'none'}, profile is for ${team}`);
    report('app entitlements', masAppEntitlementViolations(await entitlementsOf(app, work), team));
    report(
      'Info.plist',
      masInfoViolations(plistJson(path.join(app, 'Contents', 'Info.plist')), {
        version,
        buildNumber,
      }),
    );

    const frameworks = path.join(app, 'Contents', 'Frameworks');
    for (const helper of readdirSync(frameworks).filter((name) => name.endsWith('.app')))
      report(
        helper,
        masChildEntitlementViolations(await entitlementsOf(path.join(frameworks, helper), work)),
      );

    const helpersDir = path.join(app, 'Contents', 'Helpers');
    const entries: BundleEntry[] = readdirSync(helpersDir, { withFileTypes: true }).map(
      (entry) => ({
        name: entry.name,
        type: entry.isSymbolicLink()
          ? 'symlink'
          : entry.isFile()
            ? 'file'
            : entry.isDirectory()
              ? 'directory'
              : 'other',
        ...(entry.isSymbolicLink()
          ? { target: readlinkSync(path.join(helpersDir, entry.name)) }
          : {}),
      }),
    );
    report('Contents/Helpers', masHelperViolations(entries));

    // The same verifier the shipped app runs before it starts an engine.
    try {
      await verifyMasNativePayload(path.join(app, 'Contents', 'Resources', 'gezel-native'));
    } catch (error) {
      failures.push(`Gezel engines: ${error instanceof Error ? error.message : String(error)}`);
    }

    report(
      path.basename(pkg),
      installerSignatureViolations(
        run('/usr/sbin/pkgutil', ['--check-signature', pkg]).output,
        team,
      ),
    );
    process.stdout.write(`  ${path.basename(pkg)}: ${version} (${buildNumber}) for team ${team}\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const [mode, ...rest] = process.argv.slice(2);
const defaultArtifactsDir = path.join(packageRoot, 'dist', 'artifacts');
if (mode === 'msix') checkMsix(path.resolve(rest[0] ?? defaultArtifactsDir));
else if (mode === 'mas')
  await checkMas(rest[0] ?? '', path.resolve(rest[1] ?? defaultArtifactsDir));
else
  fail('Usage: check-store-packages.ts msix [artifacts-dir] | mas <build-number> [artifacts-dir]');

if (failures.length > 0) {
  process.stderr.write(
    `Store package policy failed:\n${failures.map((line) => `  ${line}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `${mode === 'msix' ? 'Microsoft Store' : 'Mac App Store'} packages passed store policy\n`,
);
