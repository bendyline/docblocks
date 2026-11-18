import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  checkNativePayload,
  pinnedNativeManifest,
  stagedNativeManifest,
  withoutUv,
  type NativeFileManifest,
} from '../main/ai/gezel-staged-native.js';

const require = createRequire(import.meta.url);
const pin = (bytes: string) => ({
  sha256: createHash('sha256').update(bytes).digest('hex'),
  sizeBytes: Buffer.byteLength(bytes),
  signature: 'hash-only' as const,
});
const RELEASE = '0.0.1';
const PINS: NativeFileManifest = {
  schemaVersion: 2,
  release: RELEASE,
  platforms: {
    'win32-x64': {
      files: { 'gezel-service-host.exe': pin('host'), 'uv.exe': pin('uv') },
      symlinks: {},
    },
    'win32-x64-cpu': { files: { 'gezel-llama-server.exe': pin('llama') }, symlinks: {} },
    'darwin-arm64': {
      files: { 'gezel-apple-fm': pin('apple'), uv: pin('uv') },
      symlinks: {},
    },
    'darwin-arm64-metal': {
      files: { 'gezel-llama-server': pin('llama'), 'libggml.dylib': pin('ggml') },
      symlinks: { 'libggml.1.dylib': 'libggml.dylib' },
    },
    'linux-x64': { files: { 'gezel-service-host': pin('host'), uv: pin('uv') }, symlinks: {} },
  },
};

describe('Gezel pins for a staged payload', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-gezel-windows-'));
    await mkdir(path.join(root, 'win32-x64'));
    await mkdir(path.join(root, 'win32-x64-cpu'));
    await writeFile(path.join(root, 'release.json'), JSON.stringify({ release: RELEASE }));
    await writeFile(path.join(root, 'win32-x64', 'gezel-service-host.exe'), 'host');
    await writeFile(path.join(root, 'win32-x64-cpu', 'gezel-llama-server.exe'), 'llama');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const check = (manifest: NativeFileManifest, platform: NodeJS.Platform = 'win32', arch = 'x64') =>
    checkNativePayload(root, { release: RELEASE, manifest, platform, arch });
  const reason = async (operation: Promise<unknown>) => {
    try {
      await operation;
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('expected rejection');
  };

  it('drops only UV, on every platform, and leaves the pins it was given alone', () => {
    const pins = withoutUv(PINS);
    expect(Object.keys(pins.platforms['win32-x64'].files)).to.deep.equal([
      'gezel-service-host.exe',
    ]);
    expect(Object.keys(pins.platforms['darwin-arm64'].files)).to.deep.equal(['gezel-apple-fm']);
    expect(Object.keys(pins.platforms['linux-x64'].files)).to.deep.equal(['gezel-service-host']);
    // Platforms that never held UV are the same objects, not copies.
    expect(pins.platforms['win32-x64-cpu']).to.equal(PINS.platforms['win32-x64-cpu']);
    expect(pins.platforms['darwin-arm64-metal']).to.equal(PINS.platforms['darwin-arm64-metal']);
    expect(pins.release).to.equal(RELEASE);
    expect(PINS.platforms['win32-x64'].files).to.have.property('uv.exe');
    expect(PINS.platforms['darwin-arm64'].files).to.have.property('uv');
  });

  it('accepts a complete staged payload that the full pin set rejects for its missing UV', async () => {
    expect(await reason(check(PINS))).to.equal('missing: win32-x64/uv.exe');
    await check(withoutUv(PINS));
  });

  it('confirms presence and size only: same-size bytes are the signature’s business', async () => {
    await writeFile(path.join(root, 'win32-x64', 'gezel-service-host.exe'), 'HOST');
    await check(withoutUv(PINS));
  });

  it('rejects another release, a missing or resized file, and an unpinned platform', async () => {
    const pins = withoutUv(PINS);
    await writeFile(path.join(root, 'release.json'), JSON.stringify({ release: '0.0.0' }));
    expect(await reason(check(pins))).to.equal('engines are release 0.0.0; this build needs 0.0.1');
    await rm(path.join(root, 'release.json'));
    expect(await reason(check(pins))).to.contain('release.json is unreadable');
    await writeFile(path.join(root, 'release.json'), JSON.stringify({ release: RELEASE }));
    await writeFile(path.join(root, 'win32-x64', 'gezel-service-host.exe'), 'host, resized');
    expect(await reason(check(pins))).to.equal('size mismatch: win32-x64/gezel-service-host.exe');
    await writeFile(path.join(root, 'win32-x64', 'gezel-service-host.exe'), 'host');
    await rm(path.join(root, 'win32-x64-cpu', 'gezel-llama-server.exe'));
    expect(await reason(check(pins))).to.equal('missing: win32-x64-cpu/gezel-llama-server.exe');
    expect(await reason(check(pins, 'linux', 'arm64'))).to.equal(
      'no engines are pinned for linux-arm64',
    );
  });

  it('rejects a redirected pinned symlink', async function () {
    if (process.platform === 'win32') this.skip();
    const metal = path.join(root, 'darwin-arm64-metal');
    await mkdir(path.join(root, 'darwin-arm64'));
    await mkdir(metal);
    await writeFile(path.join(root, 'darwin-arm64', 'gezel-apple-fm'), 'apple');
    await writeFile(path.join(metal, 'gezel-llama-server'), 'llama');
    await writeFile(path.join(metal, 'libggml.dylib'), 'ggml');
    await symlink('libggml.dylib', path.join(metal, 'libggml.1.dylib'));
    const pins = withoutUv(PINS);
    await check(pins, 'darwin', 'arm64');
    await rm(path.join(metal, 'libggml.1.dylib'));
    await symlink('gezel-llama-server', path.join(metal, 'libggml.1.dylib'));
    expect(await reason(check(pins, 'darwin', 'arm64'))).to.equal(
      'symlink changed: darwin-arm64-metal/libggml.1.dylib',
    );
  });

  it('checks Mac App Store executables for presence at any size, under the same release', async () => {
    const executables = [
      'win32-x64/gezel-service-host.exe',
      'win32-x64-cpu/gezel-llama-server.exe',
    ];
    const store = () => checkNativePayload(root, { release: RELEASE, executables });
    await writeFile(path.join(root, 'win32-x64', 'gezel-service-host.exe'), 'host, re-signed');
    await store();
    await writeFile(path.join(root, 'win32-x64-cpu', 'gezel-llama-server.exe'), '');
    expect(await reason(store())).to.equal('missing: win32-x64-cpu/gezel-llama-server.exe');
    await writeFile(path.join(root, 'win32-x64-cpu', 'gezel-llama-server.exe'), 'llama');
    await writeFile(path.join(root, 'release.json'), JSON.stringify({ release: '0.0.0' }));
    expect(await reason(store())).to.contain('engines are release 0.0.0');
  });

  it("reads Gezel's own pins, which name UV for every platform DocBlocks ships", async () => {
    const full = JSON.parse(
      await readFile(
        path.join(
          path.dirname(require.resolve('@bendyline/gezel-inference/package.json')),
          'dist',
          'engines',
          'native-file-manifest.json',
        ),
        'utf8',
      ),
    ) as NativeFileManifest;
    expect(await pinnedNativeManifest(require.resolve)).to.deep.equal(full);
    const pins = await stagedNativeManifest(require.resolve);
    expect(pins.release).to.be.a('string').and.not.equal('');
    for (const [key, uv] of [
      ['win32-x64', 'uv.exe'],
      ['win32-arm64', 'uv.exe'],
      ['darwin-arm64', 'uv'],
      ['linux-x64', 'uv'],
      ['linux-arm64', 'uv'],
    ] as const) {
      // If a Gezel release stops shipping UV here, packaging fails first; this
      // says the strip is still doing something.
      expect(full.platforms[key].files, key).to.have.property(uv);
      expect(pins.platforms[key].files, key).not.to.have.property(uv);
      expect(Object.keys(pins.platforms[key].files).length, key).to.equal(
        Object.keys(full.platforms[key].files).length - 1,
      );
    }
  });
});
