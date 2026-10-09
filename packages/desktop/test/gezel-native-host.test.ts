import { expect } from 'chai';
import path from 'node:path';
import { resolveGezelNativeHost } from '../main/ai/gezel-native-host.js';

describe('bundled Gezel host policy', () => {
  it('marks MAS engines for sandbox-aware signature verification', () => {
    expect(resolveGezelNativeHost(true, '/resources', {}, 'darwin', 'arm64', true)).to.deep.include(
      {
        macAppStore: true,
        distributionProfile: 'store',
        nativeBinDir: path.join('/resources', 'gezel-native'),
        canHost: true,
      },
    );
  });
  it('pins packaged binaries to app resources and prohibits executable downloads', () => {
    const resources = path.resolve('/opt/docblocks/resources');
    expect(
      resolveGezelNativeHost(
        true,
        resources,
        {
          DOCBLOCKS_GEZEL_NATIVE_BIN_DIR: '/untrusted',
          GEZEL_DISTRIBUTION_PROFILE: 'standard',
        },
        'win32',
        'x64',
      ),
    ).to.deep.equal({
      nativeBinDir: path.join(resources, 'gezel-native'),
      distributionProfile: 'store',
      allowStandaloneMacPayload: false,
      canHost: true,
    });
  });

  it('allows an explicit verified development payload and rejects relative overrides', () => {
    const native = path.resolve('/src/gezel/native-bin');
    expect(
      resolveGezelNativeHost(false, '', { DOCBLOCKS_GEZEL_NATIVE_BIN_DIR: native }),
    ).to.deep.include({
      nativeBinDir: native,
      distributionProfile: 'standard',
      allowStandaloneMacPayload: true,
    });
    expect(() =>
      resolveGezelNativeHost(false, '', { DOCBLOCKS_GEZEL_NATIVE_BIN_DIR: './engines' }),
    ).to.throw('absolute path');
    expect(resolveGezelNativeHost(false, '', {})).not.to.have.property('nativeBinDir');
  });

  it('keeps Intel Mac hosting unavailable while the native release has no matching engines', () => {
    expect(resolveGezelNativeHost(true, '/resources', {}, 'darwin', 'x64').canHost).to.equal(false);
    expect(resolveGezelNativeHost(true, '/resources', {}, 'darwin', 'arm64').canHost).to.equal(
      true,
    );
  });
});
