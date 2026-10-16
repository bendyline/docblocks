import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'chai';
import yaml from 'js-yaml';
import type { AppUpdater, ResolvedUpdateFileInfo } from 'electron-updater';
import { MacUpdater } from 'electron-updater/out/MacUpdater.js';
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider.js';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider.js';

import { addIntelMacFinalToFeed, withIntelMacFinal } from '../scripts/intel-mac-final-feed.js';

const policy = { version: '2.7.1' };
const intelZip = 'DocBlocks-2.7.1-mac-x64.zip';

function feed(version: string, files: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    version,
    files,
    path: `DocBlocks-${version}-mac-arm64.zip`,
    sha512: 'arm',
    releaseDate: '2026-10-12T00:00:00.000Z',
  };
}

const finalIntelFeed = feed('2.7.1', [
  { url: 'DocBlocks-2.7.1-mac-arm64.zip', sha512: 'arm', size: 10 },
  { url: intelZip, sha512: 'intel', size: 20 },
]);

const laterFeed = feed('2.8.0', [
  { url: 'DocBlocks-2.8.0-mac-arm64.zip', sha512: 'arm', size: 11 },
]);

function filesOf(value: Record<string, unknown>): readonly Record<string, unknown>[] {
  const files = value.files;
  if (!Array.isArray(files)) throw new Error('files missing');
  return files as Record<string, unknown>[];
}

describe('Intel Mac final update feed', () => {
  it('points a later release at the final Intel zip in its own release', () => {
    const merged = withIntelMacFinal(laterFeed, finalIntelFeed, policy);
    expect(filesOf(merged)).to.deep.equal([
      { url: 'DocBlocks-2.8.0-mac-arm64.zip', sha512: 'arm', size: 11 },
      { url: `../desktop-v2.7.1/${intelZip}`, sha512: 'intel', size: 20 },
    ]);
    // Legacy single-file fields keep naming the Apple silicon zip.
    expect(merged.path).to.equal('DocBlocks-2.8.0-mac-arm64.zip');
  });

  it('is idempotent', () => {
    const once = withIntelMacFinal(laterFeed, finalIntelFeed, policy);
    expect(withIntelMacFinal(once, finalIntelFeed, policy)).to.deep.equal(once);
  });

  it('rejects any other Intel build', () => {
    const intelAgain = feed('2.8.0', [
      { url: 'DocBlocks-2.8.0-mac-arm64.zip', sha512: 'arm', size: 11 },
      { url: 'DocBlocks-2.8.0-mac-x64.zip', sha512: 'x', size: 12 },
    ]);
    expect(() => withIntelMacFinal(intelAgain, finalIntelFeed, policy)).to.throw(
      /no longer supported.*DocBlocks-2\.8\.0-mac-x64\.zip/u,
    );
  });

  it('requires the final release feed to carry the final Intel zip', () => {
    expect(() =>
      withIntelMacFinal(laterFeed, { ...finalIntelFeed, version: '2.6.2' }, policy),
    ).to.throw(/intel-mac-final\.json says 2\.7\.1/u);
    expect(() =>
      withIntelMacFinal(
        laterFeed,
        feed('2.7.1', [{ url: 'DocBlocks-2.7.1-mac-arm64.zip', sha512: 'arm', size: 10 }]),
        policy,
      ),
    ).to.throw(/does not list DocBlocks-2\.7\.1-mac-x64\.zip/u);
  });

  describe('as electron-updater reads it', () => {
    // electron-updater's own architecture filter, protected only in its typings.
    const { filterFilesForArch } = MacUpdater as unknown as {
      filterFilesForArch(
        files: readonly ResolvedUpdateFileInfo[],
        isArm64Mac: boolean,
      ): ResolvedUpdateFileInfo[];
    };
    const provider = new GitHubProvider(
      { provider: 'github', owner: 'bendyline', repo: 'docblocks' },
      undefined as unknown as AppUpdater,
      { platform: 'darwin' } as unknown as ProviderRuntimeOptions,
    );
    const merged = withIntelMacFinal(laterFeed, finalIntelFeed, policy);
    const files = provider.resolveFiles({
      ...(merged as unknown as Parameters<typeof provider.resolveFiles>[0]),
      tag: 'desktop-v2.8.0',
    });

    it('downloads the final Intel zip from the final release', () => {
      const intel = filterFilesForArch(files, false);
      expect(intel.map((file) => file.url.href)).to.deep.equal([
        `https://github.com/bendyline/docblocks/releases/download/desktop-v2.7.1/${intelZip}`,
      ]);
    });

    it('keeps Apple silicon (and Rosetta) on the current release', () => {
      const arm64 = filterFilesForArch(files, true);
      expect(arm64.map((file) => file.url.pathname)).to.deep.equal([
        '/bendyline/docblocks/releases/download/desktop-v2.8.0/DocBlocks-2.8.0-mac-arm64.zip',
      ]);
    });

    it('derives one blockmap URL for both versions, so none may be published', async () => {
      const intel = filterFilesForArch(files, false)[0];
      if (!intel) throw new Error('no Intel file');
      const [oldBlockMap, newBlockMap] = await provider.getBlockMapFiles(
        intel.url,
        '2.6.2',
        '2.8.0',
      );
      expect(oldBlockMap?.href).to.equal(newBlockMap?.href);
    });
  });

  describe('as release CI runs it', () => {
    let directory: string;

    beforeEach(async () => {
      directory = await mkdtemp(path.join(tmpdir(), 'docblocks-intel-feed-'));
      await writeFile(path.join(directory, 'latest-mac.yml'), yaml.dump(laterFeed));
      await writeFile(path.join(directory, 'intel.yml'), yaml.dump(finalIntelFeed));
    });

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it("writes the final release's Intel entry into a later feed", async () => {
      const feedPath = path.join(directory, 'latest-mac.yml');
      const url = await addIntelMacFinalToFeed(feedPath, path.join(directory, 'intel.yml'), policy);
      expect(url).to.equal(`../desktop-v2.7.1/${intelZip}`);
      const written = yaml.load(await readFile(feedPath, 'utf8')) as Record<string, unknown>;
      expect(filesOf(written)).to.deep.equal([
        { url: 'DocBlocks-2.8.0-mac-arm64.zip', sha512: 'arm', size: 11 },
        { url: `../desktop-v2.7.1/${intelZip}`, sha512: 'intel', size: 20 },
      ]);
    });
  });
});
