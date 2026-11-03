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
// The plugin builds against the whole chain, but only it is vendored: Gezel
// publishes the others, and the plugin must depend on those exact releases.
const packages = ['gezk', 'core', 'client', 'app-sdk', 'capacitor'];
const vendored = new Set(['capacitor']);
// Distinguish unpublished source from registry releases with the same producer version.
const preview = 'docblocks.3';
const npmCli = path.join(mobile, '../../node_modules/npm/bin/npm-cli.js');
// The recorded tree hash must describe exactly what is packed.
for (const folder of vendored)
  if (run('git', ['status', '--porcelain', '--', `packages/${folder}`], repo).trim())
    throw new Error(`Commit packages/${folder} in the Gezel checkout before packing it.`);
await withDependencyReadLease(
  repo,
  async ({ leaseEnv }) => {
    const work = await mkdtemp(path.join(tmpdir(), 'docblocks-gezel-preview-'));
    try {
      const manifests = await Promise.all(
        packages.map((folder) => read(path.join(repo, 'packages', folder, 'package.json'))),
      );
      const provenance = {
        repository: 'https://github.com/bendyline/gezel',
        baseCommit: run('git', ['rev-parse', 'HEAD'], repo).trim(),
        // Content-addressed, so it can be matched against any public commit.
        trees: Object.fromEntries(
          [...vendored].map((folder) => [
            `packages/${folder}`,
            run('git', ['rev-parse', `HEAD:packages/${folder}`], repo).trim(),
          ]),
        ),
        nativeRelease: pins,
        published: {},
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
        if (!vendored.has(folder)) continue;
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
        manifest.version = `${pkg.version}-${preview}`;
        for (const key of ['dependencies', 'optionalDependencies'])
          for (const [name, version] of Object.entries(manifest[key] ?? {})) {
            if (!name.startsWith('@bendyline/')) continue;
            if (!/^\d+\.\d+\.\d+$/u.test(version))
              throw new Error(`${pkg.name} must pin an exact ${name} release, not ${version}.`);
            const published = run(
              process.execPath,
              [npmCli, 'view', `${name}@${version}`, 'version'],
              mobile,
            ).trim();
            if (published !== version)
              throw new Error(`${name}@${version} is not published; publish it first.`);
            provenance.published[name] = version;
          }
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
              npmCli,
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
  'Capacitor preview refreshed. Install it with the published pins in provenance.json, regenerate notices, sync and qualify native builds.\n',
);
