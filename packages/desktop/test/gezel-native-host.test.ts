import { expect } from 'chai';
import path from 'node:path';
import { clearGezelEngineOverrides, resolveGezelNativeHost } from '../main/ai/gezel-native-host.js';

describe('bundled Gezel host policy', () => {
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

  it('restores engine overrides and removes variables discovered during a hosted lifetime', () => {
    const env = {
      GEZEL_NATIVE_ENGINE_VERSION: 'untrusted',
      GEZEL_LLAMA_SERVER_BIN: 'untrusted',
      GEZEL_HOME: '/state',
    } as NodeJS.ProcessEnv;
    const restore = clearGezelEngineOverrides(env);
    expect(env).to.deep.equal({ GEZEL_HOME: '/state' });
    env.GEZEL_UV_BIN = '/bundled/uv';
    restore();
    expect(env).to.deep.equal({
      GEZEL_NATIVE_ENGINE_VERSION: 'untrusted',
      GEZEL_LLAMA_SERVER_BIN: 'untrusted',
      GEZEL_HOME: '/state',
    });
  });
});
