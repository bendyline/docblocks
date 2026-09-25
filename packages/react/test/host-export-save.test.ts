import { expect } from 'chai';
import {
  EXPORT_TRANSFER_LIMITS,
  HOST_WIRE_LIMITS,
  type DocBlocksHostExportAPI,
  type HostExportTargetGrant,
} from '@bendyline/docblocks/host';
import { saveBlobToHost } from '../src/Export/host-export-save.js';

const { chunkBytes } = EXPORT_TRANSFER_LIMITS;
const SAVED: HostExportTargetGrant = { grantId: 'export_grant', displayPath: 'C:\\out\\video.mp4' };

interface HostCalls {
  save: Array<{ grantId: string | null; bytes: number }>;
  picks: Array<string | null | undefined>;
  begins: Array<{ grantId: string; size: number }>;
  chunks: Array<{ offset: number; bytes: Uint8Array }>;
  finishes: string[];
  closes: string[];
}

function fakeExports(overrides: Partial<DocBlocksHostExportAPI> = {}) {
  const calls: HostCalls = {
    save: [],
    picks: [],
    begins: [],
    chunks: [],
    finishes: [],
    closes: [],
  };
  const exports: DocBlocksHostExportAPI = {
    resolveTarget: async () => ({ grantId: null, displayPath: 'video.mp4' }),
    pickTarget: async (_documentId, _filename, currentGrantId) => {
      calls.picks.push(currentGrantId);
      return { grantId: 'picked_grant', displayPath: 'C:\\picked\\video.mp4' };
    },
    save: async (_documentId, _filename, grantId, data) => {
      calls.save.push({ grantId, bytes: data.byteLength });
      return SAVED;
    },
    beginSave: async (_documentId, _filename, grantId, size) => {
      calls.begins.push({ grantId, size });
      return 'export-upload_1';
    },
    writeChunk: async (_transferId, offset, data) => {
      calls.chunks.push({
        offset,
        bytes: data instanceof Uint8Array ? data : new Uint8Array(data),
      });
    },
    finishSave: async (transferId) => {
      calls.finishes.push(transferId);
      return SAVED;
    },
    closeTransfer: async (transferId) => {
      calls.closes.push(transferId);
    },
    ...overrides,
  };
  return { exports, calls };
}

function patternedBlob(size: number): { blob: Blob; bytes: Uint8Array } {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = index % 251;
  return { blob: new Blob([bytes], { type: 'video/mp4' }), bytes };
}

describe('host export saves', () => {
  it('keeps small exports on the one-message save', async () => {
    const { exports, calls } = fakeExports();
    const saved = await saveBlobToHost(exports, 'doc', new Blob(['abc']), 'notes.md', 'grant');

    expect(saved).to.deep.equal(SAVED);
    expect(calls.save).to.deep.equal([{ grantId: 'grant', bytes: 3 }]);
    expect(calls.begins).to.deep.equal([]);
  });

  it('streams a large export to its granted target in ordered, bounded chunks', async () => {
    const { exports, calls } = fakeExports();
    const { blob, bytes } = patternedBlob(chunkBytes * 2 + 3);

    const saved = await saveBlobToHost(exports, 'doc', blob, 'video.mp4', 'export_grant');

    expect(saved).to.deep.equal(SAVED);
    expect(calls.save).to.deep.equal([]);
    expect(calls.picks).to.deep.equal([]);
    expect(calls.begins).to.deep.equal([{ grantId: 'export_grant', size: blob.size }]);
    expect(calls.chunks.map((chunk) => chunk.offset)).to.deep.equal([
      0,
      chunkBytes,
      chunkBytes * 2,
    ]);
    expect(calls.chunks.map((chunk) => chunk.bytes.byteLength)).to.deep.equal([
      chunkBytes,
      chunkBytes,
      3,
    ]);
    const received = new Uint8Array(blob.size);
    for (const chunk of calls.chunks) received.set(chunk.bytes, chunk.offset);
    expect(received).to.deep.equal(bytes);
    expect(calls.finishes).to.deep.equal(['export-upload_1']);
    expect(calls.closes).to.deep.equal(['export-upload_1']);
  });

  it('picks a target before uploading when none is remembered', async () => {
    const { exports, calls } = fakeExports();
    const { blob } = patternedBlob(chunkBytes + 1);

    await saveBlobToHost(exports, 'doc', blob, 'video.mp4', null);

    expect(calls.picks).to.deep.equal([null]);
    expect(calls.begins).to.deep.equal([{ grantId: 'picked_grant', size: blob.size }]);
  });

  it('sends nothing when the picker is cancelled', async () => {
    const { exports, calls } = fakeExports({ pickTarget: async () => null });
    const { blob } = patternedBlob(chunkBytes + 1);

    expect(await saveBlobToHost(exports, 'doc', blob, 'video.mp4', null)).to.equal(null);
    expect(calls.begins).to.deep.equal([]);
    expect(calls.chunks).to.deep.equal([]);
  });

  it('discards the upload and reports the failure when a chunk is refused', async () => {
    let writes = 0;
    const { exports, calls } = fakeExports({
      writeChunk: async () => {
        writes += 1;
        if (writes === 2) throw new Error('There isn\'t enough space to save "video.mp4".');
      },
    });
    const { blob } = patternedBlob(chunkBytes * 2);

    let failure: unknown;
    await saveBlobToHost(exports, 'doc', blob, 'video.mp4', 'export_grant').catch((error) => {
      failure = error;
    });

    expect((failure as Error).message).to.match(/enough space/);
    expect(calls.finishes).to.deep.equal([]);
    expect(calls.closes).to.deep.equal(['export-upload_1']);
  });

  it('uses one message on a host without chunked saves, within what one message can carry', async () => {
    const { exports, calls } = fakeExports({
      beginSave: undefined,
      writeChunk: undefined,
      finishSave: undefined,
      closeTransfer: undefined,
    });
    const { blob } = patternedBlob(chunkBytes + 1);

    await saveBlobToHost(exports, 'doc', blob, 'video.mp4', 'export_grant');
    expect(calls.save).to.deep.equal([{ grantId: 'export_grant', bytes: blob.size }]);

    // Only `size` is read before refusing, so a stand-in avoids a 100 MiB buffer.
    const oversized = { size: HOST_WIRE_LIMITS.binaryBytes + 1 } as unknown as Blob;
    let failure: unknown;
    await saveBlobToHost(exports, 'doc', oversized, 'video.mp4', 'export_grant').catch((error) => {
      failure = error;
    });
    expect((failure as Error).message).to.match(/too large for this version of DocBlocks/);
    expect(calls.save).to.have.length(1);
  });
});
