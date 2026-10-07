import { expect } from 'chai';
import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  hasMasSandboxInheritance,
  parseMasNativeManifest,
  verifyMasNativeFiles,
} from '../main/ai/gezel-mas-native.js';

const require = createRequire(import.meta.url);
const { prepareMasNative, nativeManifest, machoKind } = require('../scripts/prepare-mas-gezel.cjs');
const release = 'test-release';
function macho(type: number): Buffer {
  const header = Buffer.alloc(64);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x100000c, 4);
  header.writeUInt32LE(type, 12);
  return Buffer.concat([header, Buffer.from('upstream signed bytes')]);
}

describe('MAS native provenance, layout and signing', () => {
  it('validates XML and current codesign DER output with exactly the two inheritance entitlements', () => {
    const xml =
      '<plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.inherit</key><true/></dict></plist>';
    const der =
      '[Dict]\n\t[Key] com.apple.security.app-sandbox\n\t[Value]\n\t\t[Bool] true\n\t[Key] com.apple.security.inherit\n\t[Value]\n\t\t[Bool] true\n';
    expect(hasMasSandboxInheritance(xml)).to.equal(true);
    expect(hasMasSandboxInheritance(der)).to.equal(true);
    for (const value of [
      '',
      xml.replace('<true/>', '<false/>'),
      xml.replace('</dict>', '<key>extra</key><true/></dict>'),
      der.replace('[Bool] true', '[Bool] false'),
      der.replace('[Bool] true', '[String] true'),
      der + '\t[Key] extra\n\t[Value]\n\t\t[Bool] true\n',
    ])
      expect(hasMasSandboxInheritance(value)).to.equal(false);
  });
  let temp: string;
  let root: string;
  let app: string;
  let previous: string | undefined;
  beforeEach(async function () {
    if (process.platform === 'win32') this.skip();
    temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'docblocks-mas-native-')));
    app = path.join(temp, 'DocBlocks.app');
    root = path.join(app, 'Contents', 'Resources', 'gezel-native');
    previous = process.env.GEZEL_NATIVE_BIN_DIR;
    for (const key of ['darwin-arm64', 'darwin-arm64-metal'])
      await mkdir(path.join(root, key), { recursive: true });
    for (const file of ['gezel-apple-fm', 'uv', 'gezel-sd-server'])
      await writeFile(path.join(root, 'darwin-arm64', file), macho(2), { mode: 0o755 });
    await writeFile(path.join(root, 'darwin-arm64-metal', 'gezel-llama-server'), macho(2), {
      mode: 0o755,
    });
    await writeFile(path.join(root, 'darwin-arm64-metal', 'libggml.dylib'), macho(6));
    await writeFile(path.join(root, 'darwin-arm64-metal', 'libggml-metal.so'), macho(8), {
      mode: 0o755,
    });
    await writeFile(path.join(root, 'darwin-arm64', 'LICENSE.txt'), 'license');
    await symlink('libggml.dylib', path.join(root, 'darwin-arm64-metal', 'libggml.1.dylib'));
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.GEZEL_NATIVE_BIN_DIR;
    else process.env.GEZEL_NATIVE_BIN_DIR = previous;
    if (temp) await rm(temp, { recursive: true, force: true });
  });

  async function prepare(tamper = false) {
    const original = await nativeManifest(root, release);
    const signed: Array<{ file: string; entitlements: string | null }> = [];
    const service = await import('@bendyline/gezel-service');
    if (tamper) await writeFile(path.join(root, 'darwin-arm64', 'uv'), 'tampered');
    const operation = prepareMasNative({
      root,
      appDir: '/app-source',
      pins: { NATIVE_ENGINE_RELEASE: release },
      identity: 'Apple Distribution: Bendyline',
      service: {
        reuseVerifiedElectronNativeBinaries: async () => {
          expect(signed).to.have.length(0);
          return service.reuseVerifiedElectronNativeBinaries({
            candidates: [root],
            release,
            manifest: original,
            platform: 'darwin',
            arch: 'arm64',
            allowStandaloneMacPayload: true,
            verifySignature: async () => ({ accepted: true, result: { status: 'valid' } }),
          });
        },
      },
      relocate: async (file: string) => {
        expect(path.basename(file)).to.equal('gezel-llama-server');
      },
      sign: async (file: string, _identity: string, entitlements: string | null) => {
        signed.push({ file: path.relative(app, file), entitlements });
        await writeFile(
          file,
          Buffer.concat([await readFile(file), Buffer.from(' store signature')]),
        );
      },
    });
    return { original, operation, signed };
  }
  const verify = (
    manifest: ReturnType<typeof parseMasNativeManifest>,
    deliveredByStore = false,
    verifySeal: () => Promise<void> = async () => undefined,
  ) =>
    verifyMasNativeFiles(root, manifest, {
      deliveredByStore,
      verifySeal,
      verifySignature: async () => undefined,
    });

  it('verifies source pins, relocates code and signs executable inheritance separately from .so libraries', async () => {
    const { original, operation, signed } = await prepare();
    const manifest = parseMasNativeManifest(await operation, release);
    expect(signed).to.have.length(5);
    expect(signed.find((entry) => entry.file.endsWith('/uv'))?.entitlements).to.equal(
      '/app-source/entitlements.mas.inherit.plist',
    );
    expect(signed.find((entry) => entry.file.endsWith('.so'))?.entitlements).to.equal(null);
    expect(manifest.files['darwin-arm64/uv'].sha256).not.to.equal(
      original.platforms['darwin-arm64'].files.uv.sha256,
    );
    expect(await readlink(path.join(root, 'darwin-arm64', 'uv'))).to.equal('../../../Helpers/uv');
    expect(await readlink(path.join(app, 'Contents', 'Frameworks', 'libggml.1.dylib'))).to.equal(
      'libggml.dylib',
    );
    expect(await readlink(path.join(app, 'Contents', 'Helpers', 'libggml-metal.so'))).to.equal(
      '../Frameworks/libggml-metal.so',
    );
    expect(await readFile(path.join(root, 'darwin-arm64', 'LICENSE.txt'), 'utf8')).to.equal(
      'license',
    );
    expect(
      (
        (await rejected(
          readFile(path.join(root, 'darwin-arm64', 'gezel-sd-server')),
        )) as NodeJS.ErrnoException
      ).code,
    ).to.equal('ENOENT');
    await verify(manifest);
    expect(process.env.GEZEL_NATIVE_BIN_DIR).to.equal(previous);
  });

  it('never signs or writes the new manifest if the real source verifier rejects tampering', async () => {
    const { operation, signed } = await prepare(true);
    expect((await rejected(operation)).message).to.contain('MAS native provenance failed');
    expect(signed).to.have.length(0);
    expect(
      ((await rejected(readFile(path.join(root, 'mas-manifest.json')))) as NodeJS.ErrnoException)
        .code,
    ).to.equal('ENOENT');
    expect(process.env.GEZEL_NATIVE_BIN_DIR).to.equal(previous);
  });

  it('requires the newly published helper and ARM64 Mach-O binaries', async () => {
    expect(await machoKind(path.join(root, 'darwin-arm64-metal', 'libggml-metal.so'))).to.equal(
      'library',
    );
    await rm(path.join(root, 'darwin-arm64', 'gezel-apple-fm'));
    expect((await rejected(nativeManifest(root, release))).message).to.contain('Publish and pin');
  });

  it('rejects release skew, unsafe locations, malformed pins and missing required engines', async () => {
    const { operation } = await prepare();
    const valid = parseMasNativeManifest(await operation, release);
    expect(() => parseMasNativeManifest(valid, 'other-release')).to.throw();
    expect(() => parseMasNativeManifest({ ...valid, unexpected: true }, release)).to.throw();
    for (const logical of ['../escape', '/escape', 'darwin-arm64/__proto__']) {
      const value = structuredClone(valid);
      Object.defineProperty(value.files, logical, {
        enumerable: true,
        value: valid.files['darwin-arm64/uv'],
      });
      expect(() => parseMasNativeManifest(value, release)).to.throw();
    }
    const value = structuredClone(valid);
    value.files['darwin-arm64/uv'].bundlePath = 'Contents/Helpers/../../escape';
    expect(() => parseMasNativeManifest(value, release)).to.throw();
    delete value.files['darwin-arm64/uv'];
    expect(() => parseMasNativeManifest(value, release)).to.throw();
  });

  it('rejects changed byte hashes, added executables and redirected native symlinks', async () => {
    const { operation } = await prepare();
    const manifest = parseMasNativeManifest(await operation, release);
    const uv = path.join(app, 'Contents', 'Helpers', 'uv');
    const bytes = await readFile(uv);
    await writeFile(uv, Buffer.alloc(bytes.length, 0x78));
    expect((await rejected(verify(manifest))).message).to.contain('hash mismatch');
    await writeFile(uv, bytes);
    const unexpected = path.join(root, 'darwin-arm64', 'unexpected');
    await writeFile(unexpected, 'binary', { mode: 0o755 });
    expect((await rejected(verify(manifest))).message).to.contain('Unexpected native code');
    await rm(unexpected);
    const link = path.join(root, 'darwin-arm64', 'uv');
    await rm(link);
    await symlink('../../../Helpers/gezel-apple-fm', link);
    expect((await rejected(verify(manifest))).message).to.contain('symlink set changed');
  });

  it('rejects a redirected helper plugin link', async () => {
    const { operation } = await prepare();
    const manifest = parseMasNativeManifest(await operation, release);
    const plugin = path.join(app, 'Contents', 'Helpers', 'libggml-metal.so');
    await rm(plugin);
    await symlink('../Frameworks/libggml.dylib', plugin);
    expect((await rejected(verify(manifest))).message).to.contain('plugin link changed');
  });

  it('permits store re-signing only with authenticated seals before and after verification', async () => {
    const { operation } = await prepare();
    const manifest = parseMasNativeManifest(await operation, release);
    const uv = path.join(app, 'Contents', 'Helpers', 'uv');
    await writeFile(
      uv,
      Buffer.concat([await readFile(uv), Buffer.from(' Apple delivery signature')]),
    );
    expect((await rejected(verify(manifest))).message).to.contain('hash mismatch');
    let seals = 0;
    await verify(manifest, true, async () => {
      seals++;
    });
    expect(seals).to.equal(2);
    expect(
      (
        await rejected(
          verify(manifest, true, async () => {
            throw new Error('invalid Apple seal');
          }),
        )
      ).message,
    ).to.equal('invalid Apple seal');
    let checks = 0;
    expect(
      (
        await rejected(
          verify(manifest, true, async () => {
            if (++checks === 2) throw new Error('changed Apple seal');
          }),
        )
      ).message,
    ).to.equal('changed Apple seal');
  });
});
async function rejected(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected rejection');
}
