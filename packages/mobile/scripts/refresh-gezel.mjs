/** Explicit producer refresh; normal npm ci/build never needs the sibling checkout. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import process from 'node:process';
const mobile = fileURLToPath(new URL('../', import.meta.url));
const repo = path.resolve(process.argv[2] ?? path.join(mobile, '../../../gezel'));
const load = (relative) => import(pathToFileURL(path.join(repo, relative)).href);
const { withDependencyReadLease } = await load('scripts/dependency-lease.mjs');
const { spawnPnpm } = await load('scripts/pnpm-cli.mjs');
await withDependencyReadLease(
  repo,
  async ({ leaseEnv }) => {
    const manifest = JSON.parse(await readFile(path.join(mobile, 'package.json'), 'utf8'));
    for (const [name, folder] of [
      ['@bendyline/gezel', 'core'],
      ['@bendyline/gezel-app-sdk', 'app-sdk'],
    ]) {
      const producer = JSON.parse(
        await readFile(path.join(repo, 'packages', folder, 'package.json'), 'utf8'),
      );
      if (producer.version !== manifest.dependencies[name])
        throw new Error(`Review and pin the new ${name} version before refreshing.`);
    }
    for (const command of ['build', 'pack']) {
      const args = ['--filter', '@bendyline/gezel-capacitor', command];
      if (command === 'pack') args.push('--pack-destination', path.join(mobile, 'vendor'));
      const child = spawnPnpm(args, {
        cwd: repo,
        env: { ...process.env, ...leaseEnv },
        stdio: 'inherit',
      });
      await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`SDK ${command} failed: ${code}`)),
        );
      });
    }
    const { BundledSource } = await load('packages/catalog/src/source.ts');
    const { portableCatalogModels } = await load('packages/core/src/runtime/portable-catalog.ts');
    const require = createRequire(path.join(repo, 'packages/catalog/package.json'));
    const gildePath = require.resolve('@bendyline/gilde/package.json');
    const gilde = JSON.parse(await readFile(gildePath, 'utf8'));
    const models = portableCatalogModels(
      await new BundledSource({ dataDir: path.join(path.dirname(gildePath), 'data') }).list(
        'chat-model',
      ),
    );
    const snapshot = {
      package: '@bendyline/gilde',
      version: gilde.version,
      models: models.map(({ name, license, approxSizeBytes, contextWindow, source }) => ({
        name,
        license,
        approxSizeBytes,
        contextWindow,
        source,
      })),
    };
    await writeFile(
      path.join(mobile, 'src/ai/catalog.json'),
      JSON.stringify(snapshot, null, 2) + '\n',
    );
    const file = 'bendyline-gezel-capacitor-0.1.0.tgz';
    const native = {};
    for (const target of ['ios', 'android']) {
      const nativeManifest = JSON.parse(
        await readFile(
          path.join(repo, 'packages/capacitor/native', target, 'sdk-manifest.json'),
          'utf8',
        ),
      );
      native[target] = { version: nativeManifest.packageVersion, sources: nativeManifest.sources };
    }
    const sources = {};
    for (const relative of [
      'package.json',
      'src/index.ts',
      'src/transport.ts',
      'src/chat.ts',
      'src/models.ts',
      'src/definitions.ts',
      'src/answer-text.ts',
      'ios/Sources/GezelCapacitor/GezelRuntimePlugin.swift',
      'android/src/main/java/com/bendyline/gezel/capacitor/GezelRuntimePlugin.java',
    ])
      sources[relative] = createHash('sha256')
        .update(await readFile(path.join(repo, 'packages/capacitor', relative)))
        .digest('hex');
    const provenance = {
      file,
      sha256: createHash('sha256')
        .update(await readFile(path.join(mobile, 'vendor', file)))
        .digest('hex'),
      repository: 'https://github.com/bendyline/gezel',
      baseCommit: spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
      }).stdout.trim(),
      sources,
      native,
    };
    await writeFile(
      path.join(mobile, 'vendor/provenance.json'),
      JSON.stringify(provenance, null, 2) + '\n',
    );
  },
  { command: 'Refresh DocBlocks mobile SDK and catalog', env: process.env },
);
process.stdout.write(
  'SDK refreshed. Reinstall its tarball with the governed npm CLI, regenerate notices, sync and qualify both native builds.\n',
);
