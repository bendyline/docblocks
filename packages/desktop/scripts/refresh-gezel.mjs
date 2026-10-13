/** Refresh unpublished upstream packages without retaining a fork of their sources. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import process from 'node:process';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const repo = path.resolve(process.argv[2] ?? path.join(desktop, '../../../gezel'));
const load = (relative) => import(pathToFileURL(path.join(repo, relative)).href);
const { withDependencyReadLease } = await load('scripts/dependency-lease.mjs');
const { spawnPnpm } = await load('scripts/pnpm-cli.mjs');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
const write = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const packages = ['gezk', 'core', 'client', 'catalog', 'knowledge', 'inference', 'app-sdk'];
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0)
    throw new Error(result.error?.message || result.stderr || `${command} failed`);
  return result.stdout;
}

await withDependencyReadLease(
  repo,
  async ({ leaseEnv, setChildPid }) => {
    const work = await mkdtemp(path.join(tmpdir(), 'docblocks-inference-preview-'));
    const vendor = path.join(desktop, 'vendor');
    await mkdir(vendor, { recursive: true });
    try {
      const manifests = await Promise.all(
        packages.map((folder) => read(path.join(repo, 'packages', folder, 'package.json'))),
      );
      const versions = Object.fromEntries(
        manifests.map((pkg) => [pkg.name, `${pkg.version}-docblocks.3`]),
      );
      const provenance = {
        repository: 'https://github.com/bendyline/gezel',
        baseCommit: run('git', ['rev-parse', 'HEAD'], repo).trim(),
        trackedChangesSha256: hash(run('git', ['diff', 'HEAD'], repo)),
        packages: {},
      };
      const pnpm = async (args) => {
        const child = spawnPnpm(args, {
          cwd: repo,
          env: { ...process.env, ...leaseEnv },
          stdio: 'inherit',
        });
        await setChildPid(child.pid);
        await new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`Gezel command failed: ${code}`)),
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
        for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
          for (const name of Object.keys(manifest[key] ?? {})) {
            if (versions[name]) manifest[key][name] = versions[name];
          }
        }
        await write(path.join(staged, 'package.json'), manifest);
        const [output] = JSON.parse(
          run(
            process.execPath,
            [
              path.join(desktop, '../../node_modules/npm/bin/npm-cli.js'),
              'pack',
              '--ignore-scripts',
              '--json',
              '--pack-destination',
              vendor,
            ],
            staged,
          ),
        );
        provenance.packages[pkg.name] = {
          version: manifest.version,
          file: output.filename,
          sha256: hash(await readFile(path.join(vendor, output.filename))),
        };
      }
      await write(path.join(vendor, 'provenance.json'), provenance);
      const manifestPath = path.join(desktop, 'package.json');
      const manifest = await read(manifestPath);
      delete manifest.dependencies['@bendyline/gezel-service'];
      delete manifest.devDependencies['@bendyline/gezel'];
      for (const [name, entry] of Object.entries(provenance.packages))
        manifest.dependencies[name] = `file:vendor/${entry.file}`;
      await write(manifestPath, manifest);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
  { command: 'Refresh DocBlocks inference preview packages', env: process.env },
);
process.stdout.write(
  'Upstream preview refreshed. Install with npm install --install-strategy=nested to keep desktop and mobile previews together, then regenerate notices.\n',
);
