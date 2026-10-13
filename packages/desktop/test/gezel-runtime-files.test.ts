import { expect } from 'chai';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const {
  requiredInferenceAssets,
  verifyGezelRuntimeFiles,
} = require('../scripts/gezel-runtime-files.cjs');
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inferencePath = 'node_modules/@bendyline/gezel-inference';
const execFileAsync = promisify(execFile);

describe('Gezel inference packaging', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-inference-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function fixtureAsar(extra: string[] = [], omit?: string): Promise<string> {
    const files = requiredInferenceAssets
      .filter((file: string) => file !== omit)
      .map((file: string) => `${inferencePath}/${file}`);
    for (const file of [...files, ...extra]) {
      const target = path.join(root, 'app', file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'fixture');
    }
    const target = path.join(root, 'app.asar');
    await asar.createPackage(path.join(root, 'app'), target);
    return target;
  }
  it('accepts the shared workers, generated catalog and licensed speech assets', async () => {
    await verifyGezelRuntimeFiles(await fixtureAsar());
  });
  for (const name of ['gezel-service', 'gilde', 'gezel-mcp']) {
    it(`rejects ${name} reintroduced by a nested dependency`, async () => {
      const target = await fixtureAsar([
        `node_modules/host/node_modules/@bendyline/${name}/package.json`,
      ]);
      const error = await verifyGezelRuntimeFiles(target).catch((cause: Error) => cause);
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.contain('Full Gezel product dependency');
    });
  }
  it('rejects an artifact missing the knowledge worker', async () => {
    const error = await verifyGezelRuntimeFiles(
      await fixtureAsar([], 'dist/knowledge/search-worker.js'),
    ).catch((cause: Error) => cause);
    expect(error).to.be.instanceOf(Error);
    expect(error.message).to.contain('Missing Gezel runtime asset');
  });
  it('boots the installed SDK and inference package and streams a local provider reply', async function () {
    this.timeout(30_000);
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(desktopRoot, 'test/helpers/gezel-inference-smoke.mjs'), path.join(root, 'home')],
      {
        timeout: 25_000,
        env: {
          ...process.env,
          GEZEL_MOCK_PROVIDER: '1',
          GEZEL_LOG_LEVEL: 'error',
          GEZEL_HOME: path.join(root, 'unavailable'),
          GEZEL_SYSTEM_SERVICE_HOME: path.join(root, 'system'),
        },
      },
    );
    expect(stdout).to.contain('Inference SDK smoke passed');
  });
});
