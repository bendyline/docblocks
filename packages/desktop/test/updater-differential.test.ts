import { expect } from 'chai';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  blockMapFileSize,
  differentialBaseProblem,
  MAX_COMPRESSED_BLOCKMAP_BYTES,
} from '../main/updater-differential.js';

/** A blockmap in electron-builder's format for one file split into `sizes`. */
function blockMap(sizes: readonly number[]): Uint8Array {
  return gzipSync(
    JSON.stringify({
      version: '2',
      files: [{ name: 'file', offset: 0, checksums: sizes.map(() => 'checksum'), sizes }],
    }),
  );
}

describe('differential update base', () => {
  let directory = '';
  let installerPath = '';
  let cachedBlockMapPath = '';
  let publishedDownloads = 0;

  function sources(published: Uint8Array | Error = new Error('not published')) {
    return {
      installerPath,
      cachedBlockMapPath,
      fetchPublishedBlockMap: async (): Promise<Uint8Array> => {
        publishedDownloads += 1;
        if (published instanceof Error) throw published;
        return published;
      },
    };
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'docblocks-updater-differential-'));
    installerPath = path.join(directory, 'installer.exe');
    cachedBlockMapPath = path.join(directory, 'current.blockmap');
    publishedDownloads = 0;
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reads the described file size out of a blockmap', () => {
    expect(blockMapFileSize({ version: '2', files: [{ offset: 0, sizes: [40, 60] }] })).to.equal(
      100,
    );
    expect(blockMapFileSize({ version: '2', files: [{ offset: 8, sizes: [2] }] })).to.equal(10);
  });

  it('reports anything that is not a blockmap as describing no file', () => {
    for (const value of [
      null,
      'blockmap',
      {},
      { files: [] },
      { files: [{ offset: 0 }] },
      { files: [{ offset: 0, sizes: [1, -1] }] },
      { files: [{ offset: 0, sizes: [1.5] }] },
      { files: [{ offset: '0', sizes: [1] }] },
    ]) {
      expect(blockMapFileSize(value), JSON.stringify(value)).to.equal(null);
    }
  });

  it('accepts a cached installer its cached blockmap describes, without a download', async () => {
    await writeFile(installerPath, Buffer.alloc(100));
    await writeFile(cachedBlockMapPath, blockMap([40, 60]));

    expect(await differentialBaseProblem(sources())).to.equal(null);
    expect(publishedDownloads).to.equal(0);
  });

  // An update that was downloaded but never installed leaves the next
  // version's blockmap beside the installer of the running one.
  it('rejects a cached installer its cached blockmap does not describe', async () => {
    await writeFile(installerPath, Buffer.alloc(100));
    await writeFile(cachedBlockMapPath, blockMap([40, 60, 30]));

    expect(await differentialBaseProblem(sources(blockMap([100])))).to.equal(
      'the cached installer is 100 bytes and its blockmap describes 130',
    );
    // electron-updater would use the cached blockmap, so the published one is irrelevant.
    expect(publishedDownloads).to.equal(0);
  });

  it('checks the published blockmap when none is cached', async () => {
    await writeFile(installerPath, Buffer.alloc(100));

    expect(await differentialBaseProblem(sources(blockMap([25, 75])))).to.equal(null);
    expect(publishedDownloads).to.equal(1);
  });

  // The 2.7.11 arm64 installer under a feed that named the combined installer.
  it('rejects an installer that is not the one the feed published a blockmap for', async () => {
    await writeFile(installerPath, Buffer.alloc(41));

    expect(await differentialBaseProblem(sources(blockMap([64, 64])))).to.equal(
      'the cached installer is 41 bytes and its blockmap describes 128',
    );
  });

  it('falls back to the published blockmap when the cached one is unreadable', async () => {
    await writeFile(installerPath, Buffer.alloc(100));
    await writeFile(cachedBlockMapPath, 'not gzip');

    expect(await differentialBaseProblem(sources(blockMap([100])))).to.equal(null);
    expect(publishedDownloads).to.equal(1);
  });

  it('rejects a blockmap that describes no file', async () => {
    await writeFile(installerPath, Buffer.alloc(100));
    await writeFile(cachedBlockMapPath, gzipSync(JSON.stringify({ version: '2', files: [] })));

    expect(await differentialBaseProblem(sources())).to.equal(
      'the cached installer has no usable blockmap',
    );
  });

  it('reports a missing cached installer without downloading anything', async () => {
    expect(await differentialBaseProblem(sources(blockMap([100])))).to.equal(
      'no installer is cached',
    );
    expect(publishedDownloads).to.equal(0);
  });

  it('rejects when the published blockmap cannot be downloaded', async () => {
    await writeFile(installerPath, Buffer.alloc(100));
    let failure: unknown;
    try {
      await differentialBaseProblem(sources(new Error('HTTP 404')));
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    expect((failure as Error).message).to.equal('HTTP 404');
  });

  it('refuses a published blockmap larger than any installer needs', async () => {
    await writeFile(installerPath, Buffer.alloc(100));
    let failure: unknown;
    try {
      await differentialBaseProblem(sources(new Uint8Array(MAX_COMPRESSED_BLOCKMAP_BYTES + 1)));
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    expect((failure as Error).message).to.include('at most');
  });
});
