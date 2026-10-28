import { expect } from 'chai';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const serviceRequire = createRequire(require.resolve('@bendyline/gezel-inference/package.json'));
const {
  sourceBuildStagingProblem,
  stageForSourceBuild,
  stageForTarget,
} = require('../scripts/stage-gezel-native.cjs');
const { REQUIRED_DLLS } = require('../scripts/stage-vc-runtime.cjs');

describe('Gezel native packaging adapter', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-gezel-stage-'));
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@bendyline/gezel-inference': serviceRequire('./package.json').version,
        },
      }),
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('hands the MAS OS and electron-builder destination to the inference packager', async () => {
    const calls: unknown[] = [];
    const verificationCalls: unknown[] = [];
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
        verifyNativePlatformRequirements: async (options: unknown) => {
          expect(calls).to.have.length(1);
          verificationCalls.push(options);
        },
      },
    );
    expect(verificationCalls).to.deep.equal([
      { directory: path.join(root, 'dist', 'gezel-native', 'mac-arm64'), platform: 'darwin' },
    ]);
    expect(calls).to.deep.equal([
      {
        platform: 'darwin',
        arch: 'arm64',
        destination: path.join(root, 'dist', 'gezel-native', 'mac-arm64'),
        cache: path.join(root, 'dist', 'gezel-native-cache'),
      },
    ]);
  });

  it('retains the exact inference release gate before invoking the upstream packager', async () => {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@bendyline/gezel-inference': '0.0.0' } }),
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

  it('refuses every Intel Mac build, including the final version', async () => {
    for (const version of ['2.7.1', '2.8.0']) {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
          version,
          dependencies: { '@bendyline/gezel-inference': serviceRequire('./package.json').version },
        }),
      );
      let staged = false;
      try {
        await stageForTarget(
          {
            packager: { info: { appDir: root }, platform: { buildConfigurationKey: 'mac' } },
            electronPlatformName: 'darwin',
            arch: 1,
          },
          {
            stageElectronNative: async () => {
              staged = true;
            },
          },
        );
        expect.fail(`Expected an Intel Mac build of ${version} to fail`);
      } catch (error) {
        expect((error as Error).message).to.contain('Intel Macs are no longer supported');
      }
      expect(staged).to.equal(false);
    }
  });

  it('stages a source build into the folder packaging copies from', async () => {
    const calls: { destination: string; platform: string; arch: string }[] = [];
    const destination = await stageForSourceBuild(
      { appDir: root, platform: 'win32', arch: 'x64' },
      {
        stageElectronNative: async (options: {
          destination: string;
          platform: string;
          arch: string;
        }) => {
          calls.push(options);
        },
        verifyNativePlatformRequirements: async () => {},
      },
    );
    expect(destination).to.equal(path.join(root, 'dist', 'gezel-native', 'win-x64'));
    expect(calls).to.have.length(1);
    expect(calls[0]).to.include({ destination, platform: 'win32', arch: 'x64' });
  });

  it('reports a missing or stale source-build payload without downloading anything', async () => {
    const options = { appDir: root, platform: 'win32', arch: 'x64', env: {}, release: '0.1.54' };
    expect(await sourceBuildStagingProblem(options)).to.equal(
      'No Gezel engines are staged for release 0.1.54.',
    );
    const staged = path.join(root, 'dist', 'gezel-native', 'win-x64');
    await mkdir(staged, { recursive: true });
    await writeFile(path.join(staged, 'release.json'), JSON.stringify({ release: '0.1.46' }));
    expect(await sourceBuildStagingProblem(options)).to.equal(
      'The staged Gezel engines are release 0.1.46, but this build pins 0.1.54.',
    );
    await writeFile(path.join(staged, 'release.json'), JSON.stringify({ release: '0.1.54' }));
    expect(await sourceBuildStagingProblem(options)).to.equal(null);
    // An explicit payload is the developer's own choice.
    await rm(staged, { recursive: true, force: true });
    expect(
      await sourceBuildStagingProblem({
        ...options,
        env: { DOCBLOCKS_GEZEL_NATIVE_BIN_DIR: path.join(root, 'elsewhere') },
      }),
    ).to.equal(null);
  });

  it('stages the app-local Visual C++ runtime beside a Windows package', async () => {
    const crt = path.join(root, 'crt');
    await mkdir(crt);
    for (const dll of REQUIRED_DLLS) await writeFile(path.join(crt, dll), dll);
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
