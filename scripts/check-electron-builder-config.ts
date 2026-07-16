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
