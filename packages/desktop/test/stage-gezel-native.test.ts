import { expect } from 'chai';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const serviceRequire = createRequire(require.resolve('@bendyline/gezel-service/package.json'));
const { stageForTarget } = require('../scripts/stage-gezel-native.cjs');

describe('Gezel native packaging adapter', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-gezel-stage-'));
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@bendyline/gezel-service': serviceRequire('./package.json').version,
        },
      }),
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('hands the MAS OS and electron-builder destination to the service packager', async () => {
    const calls: unknown[] = [];
    await stageForTarget(
      {
        packager: { info: { appDir: root }, platform: { buildConfigurationKey: 'mac' } },
        electronPlatformName: 'mas',
        arch: 3,
      },
      {
        stageElectronNative: async (options: unknown) => {
          calls.push(options);
        },
      },
    );
    expect(calls).to.deep.equal([
      {
        platform: 'darwin',
        arch: 'arm64',
        destination: path.join(root, 'dist', 'gezel-native', 'mac-arm64'),
        cache: path.join(root, 'dist', 'gezel-native-cache'),
      },
    ]);
  });

  it('retains the exact service release gate before invoking the upstream packager', async () => {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@bendyline/gezel-service': '0.0.0' } }),
    );
    let called = false;
    try {
      await stageForTarget(
        { packager: { info: { appDir: root } }, electronPlatformName: 'linux', arch: 1 },
        {
          stageElectronNative: async () => {
            called = true;
          },
        },
      );
      expect.fail('Expected mismatched pin to fail');
    } catch (error) {
      expect((error as Error).message).to.contain('exact dependency pin');
    }
    expect(called).to.equal(false);
  });

  it('stages the app-local Visual C++ runtime beside a Windows package', async () => {
    const crt = path.join(root, 'crt');
    await mkdir(crt);
    for (const dll of ['msvcp140.dll', 'vcruntime140.dll'])
      await writeFile(path.join(crt, dll), dll);
    await stageForTarget(
      {
        packager: { info: { appDir: root }, platform: { buildConfigurationKey: 'win' } },
        electronPlatformName: 'win32',
        arch: 1,
      },
      {
        stageElectronNative: async () => {},
        vcRuntime: { env: { DOCBLOCKS_VCRUNTIME_DIR: crt }, verify: () => undefined },
      },
    );
    expect(
      await readFile(path.join(root, 'dist', 'vc-runtime', 'x64', 'vcruntime140.dll'), 'utf8'),
    ).to.equal('vcruntime140.dll');
  });
});
