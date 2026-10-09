/** Explicit preview refresh. Installed builds never require the producer checkout. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import process from 'node:process';
const mobile = fileURLToPath(new URL('../', import.meta.url));
const repo = path.resolve(process.argv[2] ?? path.join(mobile, '../../../gezel'));
const releaseDir = process.argv[3] && path.resolve(process.argv[3]);
if (!releaseDir)
  throw new Error('Usage: refresh-gezel.mjs <gezel-checkout> <native-release-archives>');
const load = (relative) => import(pathToFileURL(path.join(repo, relative)).href);
const { withDependencyReadLease } = await load('scripts/dependency-lease.mjs');
const { spawnPnpm } = await load('scripts/pnpm-cli.mjs');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
const write = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
  return result.stdout;
}
const pins = await read(path.join(mobile, 'vendor/native-release.json'));
for (const pin of Object.values(pins.archives))
  if (hash(await readFile(path.join(releaseDir, pin.file))) !== pin.sha256)
    throw new Error(`Native release archive integrity mismatch: ${pin.file}`);
const packages = ['gezk', 'core', 'client', 'app-sdk', 'capacitor'];
await withDependencyReadLease(
  repo,
  async ({ leaseEnv }) => {
    const work = await mkdtemp(path.join(tmpdir(), 'docblocks-gezel-preview-'));
    try {
      const manifests = await Promise.all(
        packages.map((folder) => read(path.join(repo, 'packages', folder, 'package.json'))),
      );
      // Distinguish unpublished source from registry releases with the same producer version.
      const versions = Object.fromEntries(
        manifests.map((pkg) => [pkg.name, `${pkg.version}-docblocks.2`]),
      );
      const provenance = {
        repository: 'https://github.com/bendyline/gezel',
        baseCommit: run('git', ['rev-parse', 'HEAD'], repo).trim(),
        nativeRelease: pins,
        packages: {},
      };
      const pnpm = async (args) => {
        const child = spawnPnpm(args, {
          cwd: repo,
          env: { ...process.env, ...leaseEnv },
          stdio: 'inherit',
        });
        await new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`SDK command failed: ${code}`)),
          );
        });
      };
      for (const [index, folder] of packages.entries()) {
        const pkg = manifests[index];
        await pnpm(['--filter', pkg.name, 'build']);
        const raw = path.join(work, folder);
        await mkdir(raw);
        await pnpm([
          '--config.ignore-scripts=true',
          '--filter',
          pkg.name,
          'pack',
          '--pack-destination',
          raw,
        ]);
        const original = `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`;
        run('tar', ['-xzf', path.join(raw, original), '-C', raw], repo);
        const staged = path.join(raw, 'package');
        const manifest = await read(path.join(staged, 'package.json'));
        manifest.version = versions[pkg.name];
        for (const key of ['dependencies', 'optionalDependencies'])
          for (const name of Object.keys(manifest[key] ?? {}))
            if (versions[name]) manifest[key][name] = versions[name];
        await write(path.join(staged, 'package.json'), manifest);
        if (folder === 'capacitor') {
          const { stageNative, writeEmbeddingManifest, verifyCapacitorPackage } = await load(
            'packages/capacitor/scripts/embedding-package.mjs',
          );
          for (const platform of ['ios', 'android']) {
            const source = path.join(work, platform);
            await mkdir(source);
            run(
              'tar',
              ['-xzf', path.join(releaseDir, pins.archives[platform].file), '-C', source],
              repo,
            );
            await stageNative(platform, source, path.join(staged, 'native', platform));
          }
          // Pair native bridge calls with the published runtime's API, not unreleased engines.
          for (const [relative, expected] of Object.entries(pins.bridgeSources)) {
            const source = run(
              'git',
              ['show', `${pins.bridgeCommit}:packages/capacitor/${relative}`],
              repo,
            );
            if (hash(source) !== expected)
              throw new Error(`Native bridge integrity mismatch: ${relative}`);
            await writeFile(path.join(staged, relative), source);
          }
          // Released native sources are authenticated by the external archive pins above.
          // They deliberately need not match the producer checkout's newer native sources.
          await writeEmbeddingManifest(staged);
          await verifyCapacitorPackage(staged);
        }
        const output = JSON.parse(
          run(
            process.execPath,
            [
              path.join(mobile, '../../node_modules/npm/bin/npm-cli.js'),
              'pack',
              '--ignore-scripts',
              '--json',
              '--pack-destination',
              path.join(mobile, 'vendor'),
            ],
            staged,
          ),
        )[0];
        provenance.packages[pkg.name] = {
          version: manifest.version,
          file: output.filename,
          sha256: hash(await readFile(path.join(mobile, 'vendor', output.filename))),
        };
      }
      await write(path.join(mobile, 'vendor/provenance.json'), provenance);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
  { command: 'Refresh DocBlocks mobile embedding SDK preview', env: process.env },
);
process.stdout.write(
  'Preview packages refreshed. Install the five pinned tarballs, regenerate notices, sync and qualify native builds.\n',
);
