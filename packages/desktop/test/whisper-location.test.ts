import { expect } from 'chai';
import path from 'node:path';
import { findWhisperBinary } from '../main/speech/whisper-location.js';

describe('Whisper engine discovery', () => {
  const appPath = path.resolve('/src/docblocks/packages/desktop');
  const resourcesPath = path.resolve('/resources');
  const relative = path.join('darwin-arm64', 'gezel-whisper-server');
  const stagedDir = path.join(appPath, 'dist', 'gezel-native', 'mac-arm64');
  const stagedRelease = path.join(stagedDir, 'release.json');
  const stagedBinary = path.join(stagedDir, relative);
  // Where Gezel keeps engines it downloaded for itself; never borrowed.
  const gezelDownload = path.resolve(
    '/developer/.gezel/apps/docblocks/engines/native-bin/0.1.48',
    relative,
  );
  const defaults = {
    isPackaged: false,
    resourcesPath,
    appPath,
    env: {},
    platform: 'darwin' as const,
    arch: 'arm64',
    versions: { macOS: '13.3' },
  };
  const installed =
    (...files: string[]) =>
    (file: string) =>
      files.includes(file);

  it('finds the engine a source build staged', () => {
    expect(
      findWhisperBinary({ ...defaults, exists: installed(stagedRelease, stagedBinary) }),
    ).to.equal(stagedBinary);
  });

  it('never borrows an engine Gezel downloaded, staged or not', () => {
    expect(findWhisperBinary({ ...defaults, exists: installed(gezelDownload) })).to.equal(null);
    expect(
      findWhisperBinary({ ...defaults, exists: installed(stagedRelease, gezelDownload) }),
    ).to.equal(null);
  });

  it('does not expose an installed packaged engine on an unsupported OS', () => {
    expect(
      findWhisperBinary({
        ...defaults,
        isPackaged: true,
        versions: { macOS: '12.7' },
        exists: () => true,
      }),
    ).to.equal(null);
  });

  it('keeps packaged builds and explicit native directories authoritative', () => {
    const bundled = path.join(resourcesPath, 'gezel-native', relative);
    expect(
      findWhisperBinary({
        ...defaults,
        isPackaged: true,
        exists: installed(stagedRelease, stagedBinary),
      }),
    ).to.equal(null);
    expect(
      findWhisperBinary({
        ...defaults,
        isPackaged: true,
        env: { DOCBLOCKS_GEZEL_NATIVE_BIN_DIR: path.resolve('/override') },
        exists: installed(bundled, stagedBinary),
      }),
    ).to.equal(bundled);
    const override = path.resolve('/override');
    expect(
      findWhisperBinary({
        ...defaults,
        env: { DOCBLOCKS_GEZEL_NATIVE_BIN_DIR: override },
        exists: installed(path.join(override, 'release.json'), path.join(override, relative)),
      }),
    ).to.equal(path.join(override, relative));
    expect(
      findWhisperBinary({
        ...defaults,
        env: { DOCBLOCKS_GEZEL_NATIVE_BIN_DIR: path.resolve('/missing') },
        exists: installed(stagedRelease, stagedBinary),
      }),
    ).to.equal(null);
  });

  it('never uses staged engines in an isolated test', () => {
    expect(
      findWhisperBinary({
        ...defaults,
        env: { DOCBLOCKS_E2E_DEFAULT_ROOT: path.resolve('/workspace') },
        exists: installed(stagedRelease, stagedBinary),
      }),
    ).to.equal(null);
  });
});
