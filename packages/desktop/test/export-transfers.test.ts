import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ExportTransfers,
  type CompletedExportUpload,
  type ExportTransferLimits,
} from '../main/export-transfers.js';

const LIMITS: ExportTransferLimits = {
  fileBytes: 64,
  chunkBytes: 4,
  transfers: 2,
  idleMs: 120_000,
  lifetimeMs: 60_000,
};

/** Capture a failure whether it is thrown synchronously or rejected. */
async function failure(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error: unknown) {
    return error as Error;
  }
  throw new Error('Expected the operation to fail');
}

describe('desktop chunked export uploads', () => {
  let directory = '';
  let target = '';
  const owner = 7;

  const upload = (transfers: ExportTransfers, size: unknown, ownerId = owner) =>
    transfers.begin(
      ownerId,
      {
        documentKey: 'doc-key',
        filename: 'video.mp4',
        grantId: 'export_grant',
        absolutePath: target,
      },
      size,
    );

  const publish = (completed: CompletedExportUpload) =>
    fs.rename(completed.temporaryPath, completed.absolutePath).then(() => completed);

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-export-upload-'));
    target = path.join(directory, 'video.mp4');
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('spools beside the target and publishes a complete upload by rename', async () => {
    const transfers = new ExportTransfers(LIMITS);
    const id = await upload(transfers, 10);

    const [spool] = await fs.readdir(directory);
    expect(spool).to.match(/^\.video\.mp4\..+\.tmp$/);

    await transfers.writeChunk(owner, id, 0, new Uint8Array([0, 1, 2, 3]));
    await transfers.writeChunk(owner, id, 4, new Uint8Array([4, 5, 6, 7]).buffer);
    await transfers.writeChunk(owner, id, 8, new Uint8Array([8, 9]));
    expect(await fs.readdir(directory)).to.deep.equal([spool]);

    const completed = await transfers.finish(owner, id, publish);
    expect(completed).to.include({
      documentKey: 'doc-key',
      filename: 'video.mp4',
      grantId: 'export_grant',
      absolutePath: target,
      size: 10,
    });
    expect([...(await fs.readFile(target))]).to.deep.equal([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await fs.readdir(directory)).to.deep.equal(['video.mp4']);
  });

  it('keeps an existing target when an upload is incomplete, declined, or cancelled', async () => {
    const transfers = new ExportTransfers(LIMITS);
    await fs.writeFile(target, 'old');
    let published = 0;
    const countingPublish = async (completed: CompletedExportUpload) => {
      published += 1;
      return publish(completed);
    };

    const incomplete = await upload(transfers, 5);
    await transfers.writeChunk(owner, incomplete, 0, new Uint8Array(4));
    expect(
      (await failure(() => transfers.finish(owner, incomplete, countingPublish))).message,
    ).to.match(/incomplete/);

    const declined = await upload(transfers, 2);
    await transfers.writeChunk(owner, declined, 0, new Uint8Array(2));
    expect(await transfers.finish(owner, declined, async () => null)).to.equal(null);

    const cancelled = await upload(transfers, 2);
    await transfers.writeChunk(owner, cancelled, 0, new Uint8Array(1));
    await transfers.close(owner, cancelled);
    await failure(() => transfers.writeChunk(owner, cancelled, 1, new Uint8Array(1)));

    expect(published).to.equal(0);
    expect(await fs.readFile(target, 'utf8')).to.equal('old');
    expect(await fs.readdir(directory)).to.deep.equal(['video.mp4']);
  });

  it('validates size, chunk bounds, ordering, declared length, and ownership', async () => {
    const transfers = new ExportTransfers(LIMITS);
    for (const size of [0, -1, 1.5, '3', LIMITS.fileBytes + 1]) {
      await failure(() => upload(transfers, size));
    }
    expect((await failure(() => upload(transfers, LIMITS.fileBytes + 1))).message).to.match(
      /desktop export limit/,
    );

    const id = await upload(transfers, 3);
    expect(transfers.targetPath(owner, id)).to.equal(target);
    expect(transfers.targetPath(owner + 1, id)).to.equal(null);
    await failure(() => transfers.writeChunk(owner + 1, id, 0, new Uint8Array([1])));
    await transfers.close(owner + 1, id);
    await failure(() => transfers.writeChunk(owner, id, 1, new Uint8Array([1])));
    await failure(() => transfers.writeChunk(owner, id, 0, new Uint8Array(LIMITS.chunkBytes + 1)));
    await failure(() => transfers.writeChunk(owner, id, 0, new Uint8Array(0)));
    await failure(() => transfers.writeChunk(owner, id, 0, { byteLength: 1 }));
    await transfers.writeChunk(owner, id, 0, new Uint8Array([1, 2]));
    expect(
      (await failure(() => transfers.writeChunk(owner, id, 2, new Uint8Array([3, 4])))).message,
    ).to.match(/declared size/);
    await transfers.writeChunk(owner, id, 2, new Uint8Array([3]));
    await transfers.finish(owner, id, publish);
    expect([...(await fs.readFile(target))]).to.deep.equal([1, 2, 3]);
  });

  it('bounds concurrent uploads and discards an owner’s spools on revocation', async () => {
    const transfers = new ExportTransfers(LIMITS);
    const first = await upload(transfers, 4);
    await upload(transfers, 4);
    expect((await failure(() => upload(transfers, 4))).message).to.match(/Too many exports/);

    await transfers.revokeOwner(owner);
    expect(await fs.readdir(directory)).to.deep.equal([]);
    await failure(() => transfers.writeChunk(owner, first, 0, new Uint8Array(1)));

    // Revocation ends the old page's uploads, not the renderer's ability to save.
    const next = await upload(transfers, 1);
    await transfers.close(owner, next);
  });

  it('drops a spool whose owner was revoked while it was opening', async () => {
    const transfers = new ExportTransfers(LIMITS);
    const opening = upload(transfers, 4);
    const revoked = transfers.revokeOwner(owner);
    expect((await failure(() => opening)).message).to.match(/owner is closed/);
    await revoked;
    expect(await fs.readdir(directory)).to.deep.equal([]);
  });

  it('expires an idle upload and removes its spool', async () => {
    const transfers = new ExportTransfers({ ...LIMITS, idleMs: 20 });
    const id = await upload(transfers, 4);
    const deadline = Date.now() + 2_000;
    while ((await fs.readdir(directory)).length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await fs.readdir(directory)).to.deep.equal([]);
    await failure(() => transfers.writeChunk(owner, id, 0, new Uint8Array(1)));
  });
});
