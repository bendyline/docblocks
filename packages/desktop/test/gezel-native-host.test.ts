import { expect } from 'chai';
import path from 'node:path';
import {
  UNSTAGED_NATIVE_REASON,
  resolveGezelNativeHost,
  stagedNativeBinDir,
} from '../main/ai/gezel-native-host.js';

describe('bundled Gezel host policy', () => {
  const appPath = path.resolve('/src/docblocks/packages/desktop');
  const packaged = { isPackaged: true, resourcesPath: '/resources', appPath, env: {} };

  it('marks MAS engines for sandbox-aware signature verification', () => {
    expect(
      resolveGezelNativeHost({
        ...packaged,
        platform: 'darwin',
        arch: 'arm64',
        macAppStore: true,
        versions: { macOS: '13.3' },
      }),
    ).to.deep.include({
      macAppStore: true,
      distributionProfile: 'store',
      nativeBinDir: path.join('/resources', 'gezel-native'),
      canHost: true,
    });
  });
  it('pins packaged binaries to app resources and prohibits executable downloads', () => {
    const resources = path.resolve('/opt/docblocks/resources');
    expect(
      resolveGezelNativeHost({
        ...packaged,
        resourcesPath: resources,
        env: {
          DOCBLOCKS_GEZEL_NATIVE_BIN_DIR: '/untrusted',
          GEZEL_DISTRIBUTION_PROFILE: 'standard',
        },
        platform: 'win32',
        arch: 'x64',
      }),
    ).to.deep.equal({
      nativeBinDir: path.join(resources, 'gezel-native'),
      distributionProfile: 'store',
      allowStandaloneMacPayload: false,
      canHost: true,
    });
  });

  it('runs a source build on its staged engines and never downloads one', () => {
    const staged = stagedNativeBinDir(appPath, 'win32', 'x64');
    expect(staged).to.equal(path.join(appPath, 'dist', 'gezel-native', 'win-x64'));
    expect(stagedNativeBinDir(appPath, 'darwin', 'arm64')).to.equal(
      path.join(appPath, 'dist', 'gezel-native', 'mac-arm64'),
    );
    const source = { isPackaged: false, resourcesPath: '', appPath, env: {} };
    expect(
      resolveGezelNativeHost({
        ...source,
        platform: 'win32',
        arch: 'x64',
        exists: (file) => file === path.join(staged, 'release.json'),
      }),
    ).to.deep.equal({
      nativeBinDir: staged,
      distributionProfile: 'store',
      allowStandaloneMacPayload: true,
      canHost: true,
    });
    // Unstaged: say how to fix it rather than letting Gezel fetch engines.
    expect(
      resolveGezelNativeHost({ ...source, platform: 'win32', arch: 'x64', exists: () => false }),
    ).to.deep.equal({
      nativeBinDir: staged,
      distributionProfile: 'store',
      allowStandaloneMacPayload: true,
      canHost: false,
      unavailableReason: UNSTAGED_NATIVE_REASON,
    });
  });

  it('allows an explicit staged development payload and rejects relative overrides', () => {
    const native = path.resolve('/src/gezel/native-bin');
    const source = { isPackaged: false, resourcesPath: '', appPath };
    expect(
      resolveGezelNativeHost({
        ...source,
        env: { DOCBLOCKS_GEZEL_NATIVE_BIN_DIR: native },
        exists: (file) => file === path.join(native, 'release.json'),
      }),
    ).to.deep.include({
      nativeBinDir: native,
      distributionProfile: 'store',
      canHost: true,
    });
    expect(() =>
      resolveGezelNativeHost({ ...source, env: { DOCBLOCKS_GEZEL_NATIVE_BIN_DIR: './engines' } }),
    ).to.throw('absolute path');
  });

  it('keeps automated runs independent of the staged engines', () => {
    expect(
      resolveGezelNativeHost({
        isPackaged: false,
        resourcesPath: '',
        appPath,
        env: { DOCBLOCKS_E2E_DEFAULT_ROOT: path.resolve('/workspace') },
        exists: () => true,
      }),
    ).to.deep.equal({
      distributionProfile: 'standard',
      allowStandaloneMacPayload: true,
      canHost: true,
    });
  });

  it('keeps Intel Mac hosting unavailable while the native release has no matching engines', () => {
    expect(
      resolveGezelNativeHost({ ...packaged, platform: 'darwin', arch: 'x64' }).canHost,
    ).to.equal(false);
    expect(
      resolveGezelNativeHost({
        ...packaged,
        platform: 'darwin',
        arch: 'arm64',
        versions: { macOS: '13.3' },
      }).canHost,
    ).to.equal(true);
  });

  it('disables packaged hosting below the native OS floor with an actionable reason', () => {
    for (const [platform, versions, requirement] of [
      ['darwin', { macOS: '13.2.1' }, 'macOS 13.3'],
      ['linux', { glibc: '2.37' }, 'glibc 2.38'],
    ] as const) {
      const native = resolveGezelNativeHost({ ...packaged, platform, arch: 'arm64', versions });
      expect(native.canHost).to.equal(false);
      expect(native.unavailableReason).to.contain(requirement);
      expect(native.distributionProfile).to.equal('store');
    }
  });
});
