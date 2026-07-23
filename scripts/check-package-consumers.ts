import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { preProcessFile } from 'typescript';
import { WORKSPACE_NODE_ENGINE } from './node-engine-policy.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

interface SemverApi {
  readonly subset: (candidate: string, allowed: string) => boolean;
  readonly validRange: (range: string) => string | null;
}

const semver = require('semver') as SemverApi;

interface PackageUnderTest {
  readonly name: string;
  readonly directory: string;
  readonly runtimeImports: readonly string[];
}

interface PackResult {
  readonly filename: string;
}

interface InstalledManifest {
  readonly name?: string;
  readonly version?: string;
  readonly main?: string;
  readonly module?: string;
  readonly types?: string;
  readonly typings?: string;
  readonly bin?: string | Readonly<Record<string, string>>;
  readonly exports?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, Readonly<{ optional?: boolean }>>>;
  readonly engines?: Readonly<Record<string, string>>;
}

interface InstalledPackage {
  readonly root: string;
  readonly manifest: InstalledManifest;
}

const packages: readonly PackageUnderTest[] = [
  {
    name: '@bendyline/docblocks',
    directory: 'packages/core',
    runtimeImports: [
      '@bendyline/docblocks',
      '@bendyline/docblocks/filesystem',
      '@bendyline/docblocks/filesystem/indexeddb',
      '@bendyline/docblocks/filesystem/memory',
      '@bendyline/docblocks/filesystem/native',
      '@bendyline/docblocks/filesystem/electron',
      '@bendyline/docblocks/document',
      '@bendyline/docblocks/workspace',
      '@bendyline/docblocks/host',
      '@bendyline/docblocks/share',
      '@bendyline/docblocks/vscode',
      '@bendyline/docblocks/mcp',
      '@bendyline/docblocks/mcp/zod',
    ],
  },
  {
    name: '@bendyline/docblocks-react',
    directory: 'packages/react',
    runtimeImports: [
      '@bendyline/docblocks-react',
      '@bendyline/docblocks-react/export',
      '@bendyline/docblocks-react/settings',
      '@bendyline/docblocks-react/editor',
    ],
  },
  {
    name: '@bendyline/docblocks-cli',
    directory: 'packages/cli',
    runtimeImports: ['@bendyline/docblocks-cli'],
  },
];

const consumerTypePackages = [
  'node_modules/@types/react',
  'node_modules/@types/react-dom',
  'node_modules/@types/prop-types',
  'node_modules/csstype',
] as const;

const REACT_TYPE_PEER_RANGE = '^18.0.0 || ^19.0.0';
const REACT_DEV_TYPES_VERSION = '18.3.28';

function parsePackResult(output: string, packageName: string): PackResult {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(`${packageName}: npm pack did not return JSON`);
  }
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(`${packageName}: npm pack returned an unexpected result count`);
  }
  const first: unknown = value[0];
  if (
    typeof first !== 'object' ||
    first === null ||
    !('filename' in first) ||
    typeof first.filename !== 'string'
  ) {
    throw new Error(`${packageName}: npm pack did not report a tarball filename`);
  }
  return { filename: first.filename };
}

async function run(
  executable: string,
  args: readonly string[],
  cwd: string,
  maxBuffer = 16 * 1024 * 1024,
): Promise<string> {
  try {
    const result = await execFileAsync(executable, [...args], {
      cwd,
      env: process.env,
      maxBuffer,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    if (typeof error === 'object' && error !== null) {
      const stdout = 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '';
      const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
      const detail = [stdout, stderr].filter(Boolean).join('\n').trim();
      throw new Error(detail || String(error));
    }
    throw error;
  }
}

async function packPackage(
  npmCli: string,
  packageRoot: string,
  packageName: string,
  packsRoot: string,
): Promise<string> {
  const output = await run(
    process.execPath,
    [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', packsRoot],
    packageRoot,
  );
  const packed = parsePackResult(output, packageName);
  return path.join(packsRoot, packed.filename);
}

async function packLinkedSquisqPackages(npmCli: string, packsRoot: string): Promise<string[]> {
  const scopeRoot = path.join(repoRoot, 'node_modules', '@bendyline');
  const entries = (await readdir(scopeRoot, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const tarballs: string[] = [];

  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    if (entry.name !== 'squisq' && !entry.name.startsWith('squisq-')) continue;
    const packageRoot = path.join(scopeRoot, entry.name);
    const manifest = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    ) as InstalledManifest;
    if (manifest.name !== '@bendyline/squisq' && !manifest.name?.startsWith('@bendyline/squisq-')) {
      continue;
    }
    tarballs.push(await packPackage(npmCli, await realpath(packageRoot), manifest.name, packsRoot));
  }

  return tarballs;
}

function collectExportTargets(value: unknown, targets: Set<string>): void {
  if (typeof value === 'string') {
    if (value.startsWith('./')) targets.add(value.slice(2));
    return;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  for (const nested of Object.values(value)) collectExportTargets(nested, targets);
}

function packageNameFromSpecifier(specifier: string): string | null {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    isBuiltin(specifier) ||
    specifier.startsWith('data:')
  ) {
    return null;
  }
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolute)));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

async function assertDeclaredImports(
  packageRoot: string,
  manifest: InstalledManifest,
): Promise<void> {
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const distRoot = path.join(packageRoot, 'dist');
  const files = (await listFiles(distRoot)).filter(
    (file) => file.endsWith('.js') || file.endsWith('.d.ts'),
  );
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const importedFiles = preProcessFile(source, true, true).importedFiles;
    for (const importedFile of importedFiles) {
      const dependency = packageNameFromSpecifier(importedFile.fileName);
      if (dependency && dependency !== manifest.name && !declared.has(dependency)) {
        throw new Error(
          `${manifest.name ?? packageRoot}: ${path.relative(packageRoot, file)} imports undeclared dependency ${dependency}`,
        );
      }
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function resolveInstalledDependency(
  consumerRoot: string,
  packageRoot: string,
  dependencyName: string,
): Promise<InstalledPackage> {
  let searchRoot = packageRoot;
  const dependencyPath = dependencyName.split('/');

  while (true) {
    const dependencyRoot = path.join(searchRoot, 'node_modules', ...dependencyPath);
    try {
      const manifest = JSON.parse(
        await readFile(path.join(dependencyRoot, 'package.json'), 'utf8'),
      ) as InstalledManifest;
      return { root: dependencyRoot, manifest };
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }

    if (path.resolve(searchRoot) === path.resolve(consumerRoot)) break;
    const parent = path.dirname(searchRoot);
    const relativeToConsumer = path.relative(consumerRoot, parent);
    if (
      parent === searchRoot ||
      relativeToConsumer.startsWith('..') ||
      path.isAbsolute(relativeToConsumer)
    ) {
      break;
    }
    searchRoot = parent;
  }

  throw new Error(`${dependencyName}: could not resolve the packed install's direct dependency`);
}

async function assertEffectiveNodeEngine(
  consumerRoot: string,
  packageRoot: string,
  manifest: InstalledManifest,
): Promise<void> {
  const packageName = manifest.name ?? packageRoot;
  const advertisedRange = manifest.engines?.node;
  if (!advertisedRange || semver.validRange(advertisedRange) === null) {
    throw new Error(`${packageName}: packed manifest has no valid Node engine range`);
  }

  for (const dependencyName of Object.keys(manifest.dependencies ?? {}).sort()) {
    const dependency = await resolveInstalledDependency(consumerRoot, packageRoot, dependencyName);
    const dependencyRange = dependency.manifest.engines?.node;
    if (!dependencyRange) continue;
    if (semver.validRange(dependencyRange) === null) {
      throw new Error(
        `${packageName}: dependency ${dependencyName}@${dependency.manifest.version ?? 'unknown'} has invalid engines.node ${JSON.stringify(dependencyRange)}`,
      );
    }
    if (!semver.subset(advertisedRange, dependencyRange)) {
      throw new Error(
        `${packageName}: advertises Node ${advertisedRange}, but direct dependency ${dependencyName}@${dependency.manifest.version ?? 'unknown'} only supports ${dependencyRange}`,
      );
    }
  }
}

async function assertInstalledManifest(consumerRoot: string, packageName: string): Promise<void> {
  const packageRoot = path.join(consumerRoot, 'node_modules', ...packageName.split('/'));
  const installedRealPath = await realpath(packageRoot);
  const relativeToRepo = path.relative(repoRoot, installedRealPath);
  if (
    relativeToRepo === '' ||
    (!relativeToRepo.startsWith('..') && !path.isAbsolute(relativeToRepo))
  ) {
    throw new Error(
      `${packageName}: resolved back into the workspace instead of the packed install`,
    );
  }

  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as InstalledManifest;
  const thirdPartyNotice = path.join(packageRoot, 'THIRD_PARTY_NOTICES.txt');
  if (!(await stat(thirdPartyNotice)).isFile()) {
    throw new Error(`${packageName}: packed install is missing THIRD_PARTY_NOTICES.txt`);
  }
  if ((await readFile(thirdPartyNotice, 'utf8')).length < 1_000) {
    throw new Error(`${packageName}: packed third-party notice is unexpectedly small`);
  }
  const targets = new Set<string>();
  for (const target of [manifest.main, manifest.module, manifest.types, manifest.typings]) {
    if (target?.startsWith('./')) targets.add(target.slice(2));
  }
  if (typeof manifest.bin === 'string') targets.add(manifest.bin.replace(/^\.\//, ''));
  else if (manifest.bin) {
    for (const target of Object.values(manifest.bin)) targets.add(target.replace(/^\.\//, ''));
  }
  collectExportTargets(manifest.exports, targets);

  for (const target of targets) {
    const targetPath = path.resolve(packageRoot, target);
    const relative = path.relative(packageRoot, targetPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`${packageName}: package target escapes its install: ${target}`);
    }
    if (!(await stat(targetPath)).isFile()) {
      throw new Error(`${packageName}: package target is missing: ${target}`);
    }
  }
  if (manifest.name?.startsWith('@bendyline/docblocks')) {
    if (manifest.engines?.node !== WORKSPACE_NODE_ENGINE) {
      throw new Error(
        `${packageName}: packed Node engine must match the workspace policy ${WORKSPACE_NODE_ENGINE}`,
      );
    }
    await assertEffectiveNodeEngine(consumerRoot, packageRoot, manifest);
  }
  if (manifest.name === '@bendyline/docblocks-react') {
    if (manifest.peerDependencies?.['@types/react'] !== REACT_TYPE_PEER_RANGE) {
      throw new Error(
        `${packageName}: packed React type peer must support ${REACT_TYPE_PEER_RANGE}`,
      );
    }
    if (manifest.peerDependenciesMeta?.['@types/react']?.optional !== true) {
      throw new Error(`${packageName}: packed React type peer must be optional`);
    }
    if (manifest.devDependencies?.['@types/react'] !== REACT_DEV_TYPES_VERSION) {
      throw new Error(
        `${packageName}: declaration testing must retain @types/react ${REACT_DEV_TYPES_VERSION}`,
      );
    }
  }
  if (manifest.name === '@bendyline/docblocks-cli') {
    const binTarget = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.docblocks;
    if (!binTarget) {
      throw new Error(`${packageName}: docblocks bin target is missing`);
    }
    const binSource = await readFile(path.resolve(packageRoot, binTarget), 'utf8');
    if (!binSource.startsWith('#!/usr/bin/env node')) {
      throw new Error(
        `${packageName}: docblocks bin target must start with a Node shebang so npm shims launch it correctly`,
      );
    }
    if (manifest.main === binTarget) {
      throw new Error(`${packageName}: package root and executable must use separate entry points`);
    }
    if (manifest.dependencies?.['@bendyline/squisq-editor-react'] !== undefined) {
      throw new Error(`${packageName}: CLI must not install the browser-only Squisq editor stack`);
    }
  }
  if (manifest.name?.startsWith('@bendyline/docblocks')) {
    const sourceMaps = (await listFiles(path.join(packageRoot, 'dist'))).filter((file) =>
      file.endsWith('.map'),
    );
    if (sourceMaps.length > 0) {
      throw new Error(`${packageName}: production dist must not publish source maps`);
    }
  }
  await assertDeclaredImports(packageRoot, manifest);
}

async function installPackedConsumer(
  npmCli: string,
  consumerRoot: string,
  name: string,
  packageTarballs: readonly string[],
  dependencies: readonly string[],
): Promise<void> {
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(
    path.join(consumerRoot, 'package.json'),
    JSON.stringify({ name, private: true, type: 'module' }),
  );
  await run(
    process.execPath,
    [
      npmCli,
      'install',
      // This check is also the release-order guard for public DocBlocks
      // dependencies. Force npm to revalidate registry metadata so a cached
      // pre-release packument cannot report ETARGET after Squisq is published.
      '--prefer-online',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--install-strategy=shallow',
      '--strict-peer-deps',
      ...packageTarballs,
      ...dependencies,
    ],
    consumerRoot,
    64 * 1024 * 1024,
  );
}

async function assertStrictTypeConsumer(
  consumerRoot: string,
  typeSpecifiers: readonly string[],
): Promise<void> {
  const typeImports = typeSpecifiers.map(
    (specifier, index) =>
      `import * as module${index} from ${JSON.stringify(specifier)}; void module${index};`,
  );
  await writeFile(path.join(consumerRoot, 'consumer.ts'), `${typeImports.join('\n')}\n`);
  await writeFile(
    path.join(consumerRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        lib: ['ES2020', 'DOM', 'DOM.Iterable'],
        types: ['react', 'react-dom'],
      },
      include: ['consumer.ts'],
    }),
  );
  await run(
    process.execPath,
    [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'],
    consumerRoot,
  );
}

async function main(): Promise<void> {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('npm_execpath is unavailable; run this check through npm');

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'docblocks-packed-consumer-'));
  const packsRoot = path.join(temporaryRoot, 'packs');
  const react18ConsumerRoot = path.join(temporaryRoot, 'react-18-consumer');
  const react19ConsumerRoot = path.join(temporaryRoot, 'react-19-consumer');
  await mkdir(packsRoot, { recursive: true });
  await writeFile(
    path.join(temporaryRoot, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );

  try {
    // `npm run link:squisq` is a supported parallel-development workflow.
    // Pack those symlinked packages into the isolated consumer too so the
    // check validates the exact local dependency graph before its versions
    // are published. Normal unlinked/CI installs still resolve Squisq from the
    // registry and therefore retain the release-order check.
    const linkedSquisqTarballs = await packLinkedSquisqPackages(npmCli, packsRoot);
    const tarballs: string[] = [...linkedSquisqTarballs];
    for (const packageUnderTest of packages) {
      const packageRoot = path.join(repoRoot, packageUnderTest.directory);
      tarballs.push(await packPackage(npmCli, packageRoot, packageUnderTest.name, packsRoot));
    }
    const react18TypeTarballs: string[] = [];
    for (const relativeDirectory of consumerTypePackages) {
      const packageRoot = path.join(repoRoot, relativeDirectory);
      const manifest = JSON.parse(
        await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
      ) as InstalledManifest;
      react18TypeTarballs.push(
        await packPackage(npmCli, packageRoot, manifest.name ?? relativeDirectory, packsRoot),
      );
    }

    await installPackedConsumer(
      npmCli,
      react18ConsumerRoot,
      'docblocks-packed-react-18-consumer',
      [...tarballs, ...react18TypeTarballs],
      ['react@18.3.1', 'react-dom@18.3.1'],
    );
    await installPackedConsumer(
      npmCli,
      react19ConsumerRoot,
      'docblocks-packed-react-19-consumer',
      tarballs,
      ['react@19.2.8', 'react-dom@19.2.8', '@types/react@19.2.8', '@types/react-dom@19.2.3'],
    );

    for (const packageUnderTest of packages) {
      await assertInstalledManifest(react18ConsumerRoot, packageUnderTest.name);
    }

    const imports = packages.flatMap((entry) => entry.runtimeImports);
    await writeFile(
      path.join(react18ConsumerRoot, 'runtime.mjs'),
      `${imports.map((specifier) => `await import(${JSON.stringify(specifier)});`).join('\n')}\n`,
    );
    await run(process.execPath, ['runtime.mjs'], react18ConsumerRoot);

    await Promise.all(
      [react18ConsumerRoot, react19ConsumerRoot].map((consumerRoot) =>
        assertStrictTypeConsumer(consumerRoot, imports),
      ),
    );

    await writeFile(
      path.join(react18ConsumerRoot, 'index.html'),
      '<!doctype html><html><body><script type="module" src="/browser.ts"></script></body></html>',
    );
    await writeFile(
      path.join(react18ConsumerRoot, 'browser.ts'),
      "import * as docblocksReact from '@bendyline/docblocks-react';\nimport '@bendyline/docblocks-react/styles';\nvoid docblocksReact;\n",
    );
    await writeFile(
      path.join(react18ConsumerRoot, 'vite.config.mjs'),
      "export default { worker: { format: 'es' } };\n",
    );
    await run(
      process.execPath,
      [
        path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
        'build',
        '.',
        '--outDir',
        'browser-dist',
        '--emptyOutDir',
      ],
      react18ConsumerRoot,
      64 * 1024 * 1024,
    );

    await run(
      process.execPath,
      [
        path.join(
          react18ConsumerRoot,
          'node_modules',
          '@bendyline',
          'docblocks-cli',
          'dist',
          'bin.js',
        ),
        '--help',
      ],
      react18ConsumerRoot,
    );
    process.stdout.write(
      `Packed core, React, and CLI packages${
        linkedSquisqTarballs.length > 0
          ? ` with ${linkedSquisqTarballs.length} linked Squisq packages`
          : ''
      } installed and passed export, dependency, Node engine, strict React 18/19 type, runtime, and CLI consumer checks.\n`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
