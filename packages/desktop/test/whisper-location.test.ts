import { expect } from 'chai';
import path from 'node:path';
import { findWhisperBinary } from '../main/speech/whisper-location.js';

describe('Whisper engine discovery', () => {
  const home = path.resolve('/developer');
  const gezelHome = path.join(home, '.gezel');
  const resourcesPath = path.resolve('/resources');
  const relative = path.join('darwin-arm64', 'gezel-whisper-server');
  const cached = (root: string, release = '0.1.48') =>
    path.join(root, 'engines', 'native-bin', release, relative);
  const privateBinary = cached(path.join(gezelHome, 'apps', 'docblocks'));
  const sharedBinary = cached(gezelHome);
  const defaults = {
    isPackaged: false,
    resourcesPath,
    env: {},
    platform: 'darwin' as const,
    arch: 'arm64',
    home,
    nativeRelease: '0.1.48',
  };
  const installed =
    (...files: string[]) =>
    (file: string) =>
      files.includes(file);

  it('finds the private source-app download before a shared download', () => {
    expect(
      findWhisperBinary({ ...defaults, exists: installed(privateBinary, sharedBinary) }),
    ).to.equal(privateBinary);
    expect(findWhisperBinary({ ...defaults, exists: installed(sharedBinary) })).to.equal(
      sharedBinary,
    );
  });

  it('does not silently use a different native release', () => {
    expect(
      findWhisperBinary({
        ...defaults,
        exists: installed(cached(gezelHome, '0.1.46')),
      }),
    ).to.equal(null);
  });

  it('keeps packaged builds and explicit native directories authoritative', () => {
    const bundled = path.join(resourcesPath, 'gezel-native', relative);
    expect(
      findWhisperBinary({ ...defaults, isPackaged: true, exists: installed(privateBinary) }),
    ).to.equal(null);
    expect(
      findWhisperBinary({
        ...defaults,
        isPackaged: true,
        env: { DOCBLOCKS_GEZEL_NATIVE_BIN_DIR: path.resolve('/override') },
        exists: installed(bundled, privateBinary),
      }),
    ).to.equal(bundled);
    expect(
      findWhisperBinary({
        ...defaults,
        env: { DOCBLOCKS_GEZEL_NATIVE_BIN_DIR: path.resolve('/missing') },
        exists: installed(privateBinary),
      }),
    ).to.equal(null);
  });

  it('never borrows developer downloads in MAS or an isolated test', () => {
    expect(
      findWhisperBinary({ ...defaults, macAppStore: true, exists: installed(privateBinary) }),
    ).to.equal(null);
    expect(
      findWhisperBinary({
        ...defaults,
        env: { DOCBLOCKS_E2E_DEFAULT_ROOT: path.resolve('/workspace') },
        exists: installed(privateBinary),
      }),
    ).to.equal(null);
  });

  it('honors an absolute isolated Gezel home without falling back to the personal home', () => {
    const isolatedHome = path.resolve('/test-gezel');
    const isolatedBinary = cached(path.join(isolatedHome, 'apps', 'docblocks'));
    expect(
      findWhisperBinary({
        ...defaults,
        env: { GEZEL_HOME: isolatedHome },
        exists: installed(isolatedBinary, privateBinary),
      }),
    ).to.equal(isolatedBinary);
    expect(
      findWhisperBinary({
        ...defaults,
        env: { GEZEL_HOME: isolatedHome },
        exists: installed(privateBinary),
      }),
    ).to.equal(null);
    expect(
      findWhisperBinary({
        ...defaults,
        env: { GEZEL_HOME: './relative' },
        exists: () => true,
      }),
    ).to.equal(null);
  });
});
