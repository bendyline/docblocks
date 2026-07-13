import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  readonly main?: string;
  readonly module?: string;
  readonly types?: string;
  readonly typings?: string;
  readonly bin?: string | Readonly<Record<string, string>>;
  readonly exports?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
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
    ],
  },
  {
    name: '@bendyline/docblocks-react',
    directory: 'packages/react',
    runtimeImports: [],
  },
  {
    name: '@bendyline/docblocks-cli',
    directory: 'packages/cli',
    runtimeImports: [],
  },
];

const consumerTypePackages = [
  'node_modules/@types/react',
  'node_modules/@types/react-dom',
  'node_modules/@types/prop-types',
  'node_modules/csstype',
] as const;

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
  const importPattern = /\b(?:from|import|require)\s*(?:\(\s*)?['"]([^'"]+)['"]/g;

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const dependency = packageNameFromSpecifier(match[1]);
      if (dependency && dependency !== manifest.name && !declared.has(dependency)) {
        throw new Error(
          `${manifest.name ?? packageRoot}: ${path.relative(packageRoot, file)} imports undeclared dependency ${dependency}`,
        );
      }
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
  await assertDeclaredImports(packageRoot, manifest);
}

async function main(): Promise<void> {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('npm_execpath is unavailable; run this check through npm');

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'docblocks-packed-consumer-'));
  const packsRoot = path.join(temporaryRoot, 'packs');
  const consumerRoot = path.join(temporaryRoot, 'consumer');
  await mkdir(packsRoot, { recursive: true });
  await mkdir(consumerRoot, { recursive: true });
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
    for (const relativeDirectory of consumerTypePackages) {
      const packageRoot = path.join(repoRoot, relativeDirectory);
      const manifest = JSON.parse(
        await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
      ) as InstalledManifest;
      tarballs.push(
        await packPackage(npmCli, packageRoot, manifest.name ?? relativeDirectory, packsRoot),
      );
    }

    await writeFile(
      path.join(consumerRoot, 'package.json'),
      JSON.stringify({ name: 'docblocks-packed-consumer', private: true, type: 'module' }),
    );
    await run(
      process.execPath,
      [
        npmCli,
        'install',
        '--prefer-offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        '--install-strategy=shallow',
        '--strict-peer-deps',
        ...tarballs,
        'react@18.3.1',
        'react-dom@18.3.1',
      ],
      consumerRoot,
      64 * 1024 * 1024,
    );

    for (const packageUnderTest of packages) {
      await assertInstalledManifest(consumerRoot, packageUnderTest.name);
    }

    const imports = packages.flatMap((entry) => entry.runtimeImports);
    await writeFile(
      path.join(consumerRoot, 'runtime.mjs'),
      `${imports.map((specifier) => `await import(${JSON.stringify(specifier)});`).join('\n')}\n`,
    );
    await run(process.execPath, ['runtime.mjs'], consumerRoot);

    const typeSpecifiers = [...imports, '@bendyline/docblocks-react'];
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

    await writeFile(
      path.join(consumerRoot, 'index.html'),
      '<!doctype html><html><body><script type="module" src="/browser.ts"></script></body></html>',
    );
    await writeFile(
      path.join(consumerRoot, 'browser.ts'),
      "import * as docblocksReact from '@bendyline/docblocks-react';\nvoid docblocksReact;\n",
    );
    await writeFile(
      path.join(consumerRoot, 'vite.config.mjs'),
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
      consumerRoot,
      64 * 1024 * 1024,
    );

    await run(
      process.execPath,
      [
        path.join(consumerRoot, 'node_modules', '@bendyline', 'docblocks-cli', 'dist', 'index.js'),
        '--help',
      ],
      consumerRoot,
    );
    process.stdout.write(
      `Packed core, React, and CLI packages${
        linkedSquisqTarballs.length > 0
          ? ` with ${linkedSquisqTarballs.length} linked Squisq packages`
          : ''
      } installed and passed export, dependency, type, runtime, and CLI consumer checks.\n`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
