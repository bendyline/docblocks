import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface RootManifest {
  readonly allowScripts?: Readonly<Record<string, boolean>>;
  readonly engines?: Readonly<Record<string, string>>;
  readonly packageManager?: string;
}

interface LockedPackage {
  readonly hasInstallScript?: boolean;
  readonly version?: string;
}

interface PackageLock {
  readonly packages?: Readonly<Record<string, LockedPackage>>;
}

export interface InstallScriptPolicyResult {
  readonly approvedSpecs: readonly string[];
  readonly lockedSpecs: readonly string[];
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function packageNameFromLockPath(lockPath: string): string | null {
  const marker = 'node_modules/';
  const markerIndex = lockPath.lastIndexOf(marker);
  if (markerIndex === -1) return null;
  const installedPath = lockPath.slice(markerIndex + marker.length);
  const segments = installedPath.split('/');
  const segmentCount = installedPath.startsWith('@') ? 2 : 1;
  if (segments.length < segmentCount) return null;
  return segments.slice(0, segmentCount).join('/');
}

function splitApprovalKey(key: string): { name: string; versions: readonly string[] } | null {
  const separator = key.startsWith('@') ? key.indexOf('@', key.indexOf('/') + 1) : key.indexOf('@');
  if (separator <= 0) return null;
  const name = key.slice(0, separator);
  const versions = key
    .slice(separator + 1)
    .split('||')
    .map((version) => version.trim());
  if (versions.length === 0 || versions.some((version) => !exactVersion.test(version))) {
    return null;
  }
  return { name, versions };
}

export function validateInstallScriptPolicy(
  manifest: RootManifest,
  packageLock: PackageLock,
): InstallScriptPolicyResult {
  const lockedSpecs = new Set<string>();
  for (const [lockPath, lockedPackage] of Object.entries(packageLock.packages ?? {})) {
    if (lockedPackage.hasInstallScript !== true) continue;
    const name = packageNameFromLockPath(lockPath);
    if (!name || !lockedPackage.version) {
      throw new Error(`package-lock.json has an unidentified install script at ${lockPath}`);
    }
    lockedSpecs.add(`${name}@${lockedPackage.version}`);
  }

  const policy = manifest.allowScripts;
  if (!policy || Object.keys(policy).length === 0) {
    throw new Error('package.json must declare a non-empty, version-pinned allowScripts policy');
  }

  const approvedSpecs = new Set<string>();
  for (const [key, approved] of Object.entries(policy)) {
    if (approved !== true) {
      throw new Error(`allowScripts entry ${key} must be true or be removed`);
    }
    const parsed = splitApprovalKey(key);
    if (!parsed) {
      throw new Error(
        `allowScripts entry ${key} must use exact versions, optionally joined by "||"`,
      );
    }
    for (const version of parsed.versions) {
      const spec = `${parsed.name}@${version}`;
      if (!lockedSpecs.has(spec)) {
        throw new Error(`allowScripts entry ${spec} is stale or absent from package-lock.json`);
      }
      approvedSpecs.add(spec);
    }
  }

  const unreviewed = [...lockedSpecs].filter((spec) => !approvedSpecs.has(spec)).sort();
  if (unreviewed.length > 0) {
    throw new Error(
      `package-lock.json has install scripts missing from allowScripts: ${unreviewed.join(', ')}`,
    );
  }

  return {
    approvedSpecs: [...approvedSpecs].sort(),
    lockedSpecs: [...lockedSpecs].sort(),
  };
}

function parseNpmrc(source: string): ReadonlyMap<string, readonly string[]> {
  const values = new Map<string, string[]>();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) throw new Error(`.npmrc has an invalid line: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    const existing = values.get(key) ?? [];
    existing.push(value);
    values.set(key, existing);
  }
  return values;
}

function requireNpmrcValue(
  npmrc: ReadonlyMap<string, readonly string[]>,
  key: string,
  expected: readonly string[],
): void {
  const actual = npmrc.get(key) ?? [];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `.npmrc ${key} must be ${expected.join(', ')}; found ${actual.join(', ') || '(unset)'}`,
    );
  }
}

export function validateDependencyToolchain(manifest: RootManifest, npmrcSource: string): void {
  if (manifest.engines?.npm !== '>=12.0.2') {
    throw new Error('package.json engines.npm must require >=12.0.2');
  }
  if (manifest.packageManager !== 'npm@12.0.2') {
    throw new Error('package.json packageManager must pin npm@12.0.2');
  }

  const npmrc = parseNpmrc(npmrcSource);
  requireNpmrcValue(npmrc, 'strict-allow-scripts', ['true']);
  requireNpmrcValue(npmrc, 'min-release-age', ['7']);
  requireNpmrcValue(npmrc, 'min-release-age-exclude[]', ['@bendyline/squisq*']);
  if (npmrc.has('allow-scripts') || npmrc.has('dangerously-allow-all-scripts')) {
    throw new Error(
      '.npmrc must not bypass package.json allowScripts with allow-scripts or dangerously-allow-all-scripts',
    );
  }
}

async function main(): Promise<void> {
  const [manifestSource, packageLockSource, npmrcSource] = await Promise.all([
    readFile(path.join(repoRoot, 'package.json'), 'utf8'),
    readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'),
    readFile(path.join(repoRoot, '.npmrc'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestSource) as RootManifest;
  const packageLock = JSON.parse(packageLockSource) as PackageLock;
  validateDependencyToolchain(manifest, npmrcSource);
  const result = validateInstallScriptPolicy(manifest, packageLock);
  process.stdout.write(
    `Dependency governance covers ${result.lockedSpecs.length} install-script package versions with a seven-day cooldown.\n`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
