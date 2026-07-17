/**
 * Validates packages/desktop/electron-builder.yml against the schema that the
 * installed electron-builder (app-builder-lib) ships and checks load-bearing
 * project policy such as the release architecture matrix. Catches unknown or
 * misplaced options (e.g. signtool keys that moved under `signtoolOptions` in
 * electron-builder 26) at `npm run all` time instead of during a release job.
 *
 * This does not perform packaging, so missing host tools, signing errors, and
 * similar artifact-time failures still surface in packaging jobs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(repoRoot, 'packages/desktop/electron-builder.yml');
const desktopManifestPath = path.join(repoRoot, 'packages/desktop/package.json');
const mainPath = path.join(repoRoot, 'packages/desktop/dist/main/main.cjs');
const preloadPath = path.join(repoRoot, 'packages/desktop/dist/preload/preload.cjs');

const config = yaml.load(readFileSync(configPath, 'utf8'));
// app-builder-lib is present because electron-builder depends on it; its
// scheme.json is the same schema electron-builder validates against at runtime.
const schema = JSON.parse(readFileSync(require.resolve('app-builder-lib/scheme.json'), 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

if (!validate(config)) {
  process.stderr.write(`electron-builder.yml failed schema validation:\n`);
  for (const error of validate.errors ?? []) {
    const where = error.instancePath || '(root)';
    const extra =
      error.keyword === 'additionalProperties' && error.params.additionalProperty
        ? ` ('${String(error.params.additionalProperty)}')`
        : '';
    process.stderr.write(`  ${where} ${error.message}${extra}\n`);
  }
  process.exit(1);
}

process.stdout.write('electron-builder.yml: schema OK\n');

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failConfigPolicy(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function requireTargetArchitectures(
  platformName: 'win' | 'mac' | 'linux',
  targetName: string,
  expectedArchitectures: readonly string[],
): void {
  if (!isRecord(config)) {
    failConfigPolicy('electron-builder.yml must contain an object configuration.');
  }
  const platform = config[platformName];
  if (!isRecord(platform) || !Array.isArray(platform.target)) {
    failConfigPolicy(`electron-builder.yml ${platformName}.target must be a target list.`);
  }
  const target = platform.target.find(
    (candidate) => isRecord(candidate) && candidate.target === targetName,
  );
  if (!isRecord(target) || !Array.isArray(target.arch)) {
    failConfigPolicy(
      `electron-builder.yml ${platformName} target ${targetName} must declare architectures.`,
    );
  }
  const architectures = target.arch;
  if (
    architectures.length !== expectedArchitectures.length ||
    architectures.some((architecture, index) => architecture !== expectedArchitectures[index])
  ) {
    failConfigPolicy(
      `electron-builder.yml ${platformName} target ${targetName} must build ${expectedArchitectures.join(', ')}.`,
    );
  }
}

function requireInstallerLicenseParagraphs(): void {
  if (!isRecord(config)) {
    failConfigPolicy('electron-builder.yml must contain an object configuration.');
  }
  const nsis = config.nsis;
  if (!isRecord(nsis) || typeof nsis.license !== 'string') {
    failConfigPolicy('electron-builder.yml nsis.license must name the installer license file.');
  }

  const licensePath = path.resolve(path.dirname(configPath), nsis.license);
  if (!existsSync(licensePath)) {
    failConfigPolicy(`NSIS installer license is missing at ${licensePath}.`);
  }

  const licenseParagraphs = readFileSync(licensePath, 'utf8')
    .replace(/\r\n/gu, '\n')
    .trim()
    .split(/\n[\t ]*\n/gu);
  if (licenseParagraphs.some((paragraph) => paragraph.includes('\n'))) {
    failConfigPolicy(
      'NSIS installer license paragraphs must not contain hard line breaks; the setup control wraps them to its available width.',
    );
  }

  process.stdout.write('NSIS installer license: fluid paragraph wrapping OK\n');
}

requireInstallerLicenseParagraphs();

function requireWindowsUserDataRetention(): void {
  if (!isRecord(config)) {
    failConfigPolicy('electron-builder.yml must contain an object configuration.');
  }
  const nsis = config.nsis;
  if (!isRecord(nsis)) {
    failConfigPolicy('electron-builder.yml nsis options must be configured.');
  }
  if (nsis.deleteAppDataOnUninstall === true) {
    failConfigPolicy('NSIS uninstall must retain DocBlocks user data.');
  }
  if (typeof nsis.include === 'string') {
    const includePath = path.resolve(path.dirname(configPath), nsis.include);
    if (!existsSync(includePath)) {
      failConfigPolicy(`NSIS include is missing at ${includePath}.`);
    }
    const includeSource = readFileSync(includePath, 'utf8');
    if (/!macro\s+customUnInstall(?:Section)?\b/u.test(includeSource)) {
      failConfigPolicy(
        'NSIS custom uninstall hooks are forbidden because uninstall must retain DocBlocks user data.',
      );
    }
  }

  process.stdout.write('NSIS uninstall: DocBlocks user data retained\n');
}

requireWindowsUserDataRetention();

function requireLinuxIcons(): void {
  if (!isRecord(config)) {
    failConfigPolicy('electron-builder.yml must contain an object configuration.');
  }
  const linux = config.linux;
  if (!isRecord(linux) || linux.icon !== 'icons') {
    failConfigPolicy('electron-builder.yml linux.icon must use the freedesktop icon set.');
  }

  const directories = config.directories;
  if (!isRecord(directories) || typeof directories.buildResources !== 'string') {
    failConfigPolicy('electron-builder.yml directories.buildResources must be configured.');
  }
  const linuxIconDirectory = path.resolve(
    path.dirname(configPath),
    directories.buildResources,
    linux.icon,
  );
  const requiredSizes = [16, 32, 48, 64, 128, 256, 512];
  for (const size of requiredSizes) {
    const iconPath = path.join(linuxIconDirectory, `${size}x${size}.png`);
    if (!existsSync(iconPath)) {
      failConfigPolicy(`Linux icon set is missing ${iconPath}.`);
    }
    const png = readFileSync(iconPath);
    const isPng =
      png.length >= 24 &&
      png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isPng || png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) {
      failConfigPolicy(`Linux icon ${iconPath} must be a ${size}x${size} PNG.`);
    }
  }

  const includesRuntimeIcon =
    Array.isArray(linux.extraResources) &&
    linux.extraResources.some(
      (resource) =>
        isRecord(resource) &&
        resource.from === 'resources/icon.png' &&
        resource.to === 'resources/icon.png',
    );
  if (!includesRuntimeIcon) {
    failConfigPolicy('electron-builder.yml must copy the Linux runtime icon into resources.');
  }

  process.stdout.write('electron-builder.yml: Linux launcher + runtime icons OK\n');
}

requireLinuxIcons();

for (const [platformName, targetName] of [
  ['win', 'nsis'],
  ['mac', 'dmg'],
  ['mac', 'zip'],
  ['linux', 'AppImage'],
  ['linux', 'deb'],
] as const) {
  requireTargetArchitectures(platformName, targetName, ['x64', 'arm64']);
}

process.stdout.write('electron-builder.yml: x64 + arm64 release matrix OK\n');

const configuredFiles =
  typeof config === 'object' && config !== null && 'files' in config ? config.files : null;
const requiredSourceExclusions = [
  '!dist/**/*.map',
  '!node_modules/**/*.map',
  '!node_modules/**/*.flow',
];
if (
  !Array.isArray(configuredFiles) ||
  requiredSourceExclusions.some((pattern) => !configuredFiles.includes(pattern))
) {
  process.stderr.write(
    'electron-builder.yml must exclude generated and dependency source metadata from packaged artifacts.\n',
  );
  process.exit(1);
}

interface DesktopManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

function collectRuntimeRequires(source: string): Set<string> {
  const runtimeRequires = new Set<string>();
  for (const match of source.matchAll(/\brequire\((['"])([^'"]+)\1\)/gu)) {
    runtimeRequires.add(match[2]);
  }
  return runtimeRequires;
}

function packageNameFromSpecifier(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// Production dependencies are copied wholesale by electron-builder. Keep that
// list equal to the packages the built main process actually loads; renderer
// libraries belong in devDependencies because Vite already emitted them.
if (!existsSync(mainPath)) {
  process.stderr.write(
    `Desktop main artifact is missing at ${mainPath}; build desktop before validating it.\n`,
  );
  process.exit(1);
}
const desktopManifest = JSON.parse(readFileSync(desktopManifestPath, 'utf8')) as DesktopManifest;
const declaredRuntimeDependencies = new Set([
  ...Object.keys(desktopManifest.dependencies ?? {}),
  ...Object.keys(desktopManifest.optionalDependencies ?? {}),
]);
const mainRequires = collectRuntimeRequires(readFileSync(mainPath, 'utf8'));
const requiredPackages = new Set(
  [...mainRequires]
    .filter((specifier) => specifier !== 'electron' && !isBuiltin(specifier))
    .map(packageNameFromSpecifier),
);
const undeclaredPackages = [...requiredPackages].filter(
  (dependency) => !declaredRuntimeDependencies.has(dependency),
);
const unusedProductionDependencies = [...declaredRuntimeDependencies].filter(
  (dependency) => !requiredPackages.has(dependency),
);
if (undeclaredPackages.length > 0 || unusedProductionDependencies.length > 0) {
  process.stderr.write(
    [
      undeclaredPackages.length > 0
        ? `Desktop main has undeclared runtime dependencies: ${undeclaredPackages.join(', ')}`
        : '',
      unusedProductionDependencies.length > 0
        ? `Desktop production dependencies are not loaded by main: ${unusedProductionDependencies.join(', ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n') + '\n',
  );
  process.exit(1);
}

process.stdout.write('desktop production dependencies: main-runtime-only OK\n');

// Electron's sandboxed preload exposes only a very small CommonJS surface.
// Workspace/package imports that tsup leaves as runtime `require()` calls make
// the entire preload fail before contextBridge exposes docBlocksHost. Inspect
// the artifact produced by the preceding desktop build, not just source config.
if (!existsSync(preloadPath)) {
  process.stderr.write(
    `Desktop preload artifact is missing at ${preloadPath}; build desktop before validating it.\n`,
  );
  process.exit(1);
}

const preload = readFileSync(preloadPath, 'utf8');
const runtimeRequires = collectRuntimeRequires(preload);
const unsupportedRequires = [...runtimeRequires].filter((specifier) => specifier !== 'electron');
if (unsupportedRequires.length > 0) {
  process.stderr.write(
    `Sandboxed preload contains unsupported runtime require(s): ${unsupportedRequires.join(', ')}\n`,
  );
  process.exit(1);
}

if (!preload.includes('exposeInMainWorld("docBlocksHost"')) {
  process.stderr.write('Sandboxed preload does not expose the docBlocksHost bridge.\n');
  process.exit(1);
}

process.stdout.write('desktop preload: sandbox bundle OK\n');
