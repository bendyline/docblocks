import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { verifyNativeBinaries } from '@bendyline/gezel-inference';
import {
  windowsNativeManifest,
  withoutWindowsUv,
  type NativeFileManifest,
} from '../main/ai/gezel-windows-native.js';

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
    'darwin-arm64': { files: { uv: pin('uv') }, symlinks: {} },
  },
};

describe('Windows Gezel pins', () => {
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

  it('drops only uv.exe, only from Windows, and leaves the pins it was given alone', () => {
    const pins = withoutWindowsUv(PINS);
    expect(Object.keys(pins.platforms['win32-x64'].files)).to.deep.equal([
      'gezel-service-host.exe',
    ]);
    expect(pins.platforms['win32-x64-cpu']).to.deep.equal(PINS.platforms['win32-x64-cpu']);
    expect(pins.platforms['darwin-arm64']).to.deep.equal(PINS.platforms['darwin-arm64']);
    expect(pins.release).to.equal(RELEASE);
    expect(PINS.platforms['win32-x64'].files).to.have.property('uv.exe');
  });

  it('accepts a staged payload that the full pin set rejects', async () => {
    const mine = { ...PINS, platforms: { ...PINS.platforms } };
    delete mine.platforms['darwin-arm64'];
    expect((await verify(mine)).reason).to.contain('missing: uv.exe');
    expect(await verify(withoutWindowsUv(mine))).to.include({ reused: true });
  });

  it('still rejects a uv.exe, and any other unpinned or changed file', async () => {
    const pins = withoutWindowsUv(PINS);
    await writeFile(path.join(root, 'win32-x64', 'uv.exe'), 'uv');
    expect((await verify(pins)).reason).to.contain('unexpected: uv.exe');
    await rm(path.join(root, 'win32-x64', 'uv.exe'));
    await writeFile(path.join(root, 'win32-x64', 'gezel-service-host.exe'), 'HOST');
    expect((await verify(pins)).reason).to.contain('sha256 mismatch');
  });

  it("reads Gezel's own pins, which name uv.exe for both Windows architectures", async () => {
    const pins = await windowsNativeManifest(require.resolve);
    expect(pins.release).to.be.a('string').and.not.equal('');
    for (const key of ['win32-x64', 'win32-arm64']) {
      expect(pins.platforms[key].files).to.have.property('gezel-service-host.exe');
      expect(pins.platforms[key].files).not.to.have.property('uv.exe');
    }
  });
});
