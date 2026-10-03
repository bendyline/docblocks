import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const serviceRequire = createRequire(require.resolve('@bendyline/gezel-service/package.json'));
const {
  stageNative,
  selectArchives,
  checkEntry,
  default: beforePack,
} = require('../scripts/stage-gezel-native.cjs');

describe('Gezel native packaging', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-gezel-native-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function fixture(platform: 'linux' | 'win32' = 'linux') {
    const cache = path.join(root, 'cache');
    const source = path.join(root, 'source');
    const destination = path.join(root, 'resources', 'gezel-native');
    await mkdir(cache, { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'gezel-llama-server'), 'pinned engine', { mode: 0o755 });
    await writeFile(path.join(source, 'LICENSE.txt'), 'engine license');
    const name = `gezel-native-0.1.46-${platform}-x64-cpu.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
    const archive = path.join(cache, name);
    if (platform === 'win32') {
      const Zip = serviceRequire('adm-zip');
      const zip = new Zip();
      zip.addLocalFolder(source);
      zip.writeZip(archive);
    } else {
      await serviceRequire('tar').c({ cwd: source, file: archive, gzip: true }, ['.']);
    }
    const bytes = await readFile(archive);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const pins = {
      NATIVE_ENGINE_RELEASE: '0.1.46',
      NATIVE_ENGINE_MACOS_NOTARIZED: true,
      NATIVE_ENGINE_ARCHIVE_SHA256: { [name]: sha },
    };
    return {
      platform,
      arch: 'x64',
      cache,
      source,
      destination,
      name,
      archive,
      bytes,
      pins,
      serviceRequire,
      fetchImpl: async () => {
        throw new Error('offline: network must not be used');
      },
    };
  }

  for (const platform of ['linux', 'win32'] as const) {
    it(`extracts the pinned ${platform} archive offline and preserves its licenses`, async () => {
      const input = await fixture(platform);
      await mkdir(input.destination, { recursive: true });
      await writeFile(path.join(input.destination, 'stale.dll'), 'old release');
      await stageNative(input);
      expect(
        await readFile(
          path.join(input.destination, `${platform}-x64-cpu`, 'gezel-llama-server'),
          'utf8',
        ),
      ).to.equal('pinned engine');
      expect(
        await readFile(path.join(input.destination, `${platform}-x64-cpu`, 'LICENSE.txt'), 'utf8'),
      ).to.equal('engine license');
      const manifest = JSON.parse(
        await readFile(path.join(input.destination, 'release.json'), 'utf8'),
      );
      expect(manifest.release).to.equal('0.1.46');
      expect(manifest.archives).to.have.length(1);
      await expectMissing(path.join(input.destination, 'stale.dll'));
    });
  }

  it('preserves native library symlink chains after extracting all regular files', async function () {
    if (process.platform === 'win32') this.skip();
    const input = await fixture();
    await symlink('gezel-llama-server', path.join(input.source, 'libengine.1.so'));
    await symlink('libengine.1.so', path.join(input.source, 'libengine.so'));
    await serviceRequire('tar').c({ cwd: input.source, file: input.archive, gzip: true }, ['.']);
    input.pins.NATIVE_ENGINE_ARCHIVE_SHA256[input.name] = createHash('sha256')
      .update(await readFile(input.archive))
      .digest('hex');
    await stageNative(input);
    const directory = path.join(input.destination, 'linux-x64-cpu');
    expect(await readlink(path.join(directory, 'libengine.so'))).to.equal('libengine.1.so');
    expect(await readlink(path.join(directory, 'libengine.1.so'))).to.equal('gezel-llama-server');
    expect(await readFile(path.join(directory, 'libengine.so'), 'utf8')).to.equal('pinned engine');
  });

  it('rejects a changed cached archive without replacing a staged payload', async () => {
    const input = await fixture();
    await mkdir(input.destination, { recursive: true });
    await writeFile(path.join(input.destination, 'kept.txt'), 'existing payload');
    await writeFile(input.archive, 'tampered archive');
    const error = await failed(stageNative(input));
    expect(error.message).to.contain('SHA-256 verification');
    expect(await readFile(path.join(input.destination, 'kept.txt'), 'utf8')).to.equal(
      'existing payload',
    );
  });

  it('verifies downloaded archive bytes before extraction and cleans a bad download', async () => {
    const input = await fixture();
    await rm(input.archive);
    let url = '';
    const error = await failed(
      stageNative({
        ...input,
        fetchImpl: async (requested: string) => {
          url = requested;
          return new Response('tampered download');
        },
      }),
    );
    expect(url).to.contain('/native-v0.1.46/');
    expect(error.message).to.contain('SHA-256 mismatch');
    await expectMissing(input.archive);
    await expectMissing(`${input.archive}.partial`);
    await stageNative({ ...input, fetchImpl: async () => new Response(input.bytes) });
    expect(await readFile(input.archive)).to.deep.equal(input.bytes);
  });

  it('selects every pinned backend for the target architecture, including ARM64', () => {
    const digest = 'a'.repeat(64);
    const archives = selectArchives(
      {
        NATIVE_ENGINE_RELEASE: '0.1.46',
        NATIVE_ENGINE_ARCHIVE_SHA256: {
          'gezel-native-0.1.46-win32-arm64.zip': digest,
          'gezel-native-0.1.46-win32-arm64-cpu.zip': digest,
          'gezel-native-0.1.46-win32-x64-cpu.zip': digest,
        },
      },
      'win32',
      'arm64',
    );
    expect(archives.map((entry: { platformKey: string }) => entry.platformKey)).to.deep.equal([
      'win32-arm64',
      'win32-arm64-cpu',
    ]);
  });

  it("uses electron-builder's actual context and OS macro when staging a MAS package", async () => {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@bendyline/gezel-service': serviceRequire('./package.json').version,
        },
      }),
    );
    await beforePack({
      packager: { info: { appDir: root }, platform: { buildConfigurationKey: 'mac' } },
      electronPlatformName: 'mas',
      arch: 3,
    });
    const metadata = JSON.parse(
      await readFile(path.join(root, 'dist', 'gezel-native', 'mac-arm64', 'release.json'), 'utf8'),
    );
    expect(metadata.arch).to.equal('arm64');
    expect(metadata.archives).to.deep.equal([]);
  });

  it('fails unsupported targets unless the build explicitly disables hosted AI', async () => {
    const input = await fixture();
    expect((await failed(stageNative({ ...input, platform: 'darwin' }))).message).to.contain(
      'no native archives',
    );
    await stageNative({ ...input, platform: 'darwin', allowUnavailable: true });
    expect(
      JSON.parse(await readFile(path.join(input.destination, 'release.json'), 'utf8')).archives,
    ).to.deep.equal([]);
  });

  it('rejects traversal, absolute paths, platform aliases, and extraction overflows', () => {
    for (const name of ['../escape', '/escape', 'C:/escape', 'a\\escape', 'a/../escape']) {
      expect(() => checkEntry(name, 1, { entries: 0, bytes: 0 }), name).to.throw('Unsafe');
    }
    expect(() => checkEntry('large', 9 * 1024 ** 3, { entries: 0, bytes: 0 })).to.throw('limits');
  });
});

async function failed(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected rejection');
}

async function expectMissing(file: string): Promise<void> {
  expect(((await failed(readFile(file))) as NodeJS.ErrnoException).code).to.equal('ENOENT');
}
