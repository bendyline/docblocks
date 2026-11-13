import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { verifyNativeBinaries } from '@bendyline/gezel-inference';
import {
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
    'darwin-arm64-metal': { files: { 'gezel-llama-server': pin('llama') }, symlinks: {} },
    'linux-x64': { files: { 'gezel-service-host': pin('host'), uv: pin('uv') }, symlinks: {} },
  },
};

describe('Gezel pins for a staged payload', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-gezel-windows-'));
    await mkdir(path.join(root, 'win32-x64'));
    await mkdir(path.join(root, 'win32-x64-cpu'));
    await writeFile(path.join(root, 'win32-x64', 'gezel-service-host.exe'), 'host');
    await writeFile(path.join(root, 'win32-x64-cpu', 'gezel-llama-server.exe'), 'llama');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const verify = (manifest: NativeFileManifest) =>
    verifyNativeBinaries({
      candidates: [root],
      platform: 'win32',
      arch: 'x64',
      release: RELEASE,
      manifest,
    });

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

  it('accepts a staged payload that the full pin set rejects', async () => {
    expect((await verify(PINS)).reason).to.contain('missing: uv.exe');
    expect(await verify(withoutUv(PINS))).to.include({ reused: true });
  });

  it('still rejects a uv.exe, and any other unpinned or changed file', async () => {
    const pins = withoutUv(PINS);
    await writeFile(path.join(root, 'win32-x64', 'uv.exe'), 'uv');
    expect((await verify(pins)).reason).to.contain('unexpected: uv.exe');
    await rm(path.join(root, 'win32-x64', 'uv.exe'));
    await writeFile(path.join(root, 'win32-x64', 'gezel-service-host.exe'), 'HOST');
    expect((await verify(pins)).reason).to.contain('sha256 mismatch');
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
