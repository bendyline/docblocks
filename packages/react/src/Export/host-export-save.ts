import {
  EXPORT_TRANSFER_LIMITS,
  HOST_WIRE_LIMITS,
  type DocBlocksHostExportAPI,
  type HostExportTargetGrant,
} from '@bendyline/docblocks/host';

type ChunkedExportAPI = DocBlocksHostExportAPI &
  Required<
    Pick<DocBlocksHostExportAPI, 'beginSave' | 'writeChunk' | 'finishSave' | 'closeTransfer'>
  >;

function supportsChunkedSave(exports: DocBlocksHostExportAPI): exports is ChunkedExportAPI {
  return (
    typeof exports.beginSave === 'function' &&
    typeof exports.writeChunk === 'function' &&
    typeof exports.finishSave === 'function' &&
    typeof exports.closeTransfer === 'function'
  );
}

/**
 * Save an export blob through the host. Small payloads keep the one-message
 * `save`; larger ones — long videos above all — cross in bounded chunks, so no
 * single message, and no single renderer buffer, ever holds the whole file.
 */
export async function saveBlobToHost(
  exports: DocBlocksHostExportAPI,
  documentId: string,
  blob: Blob,
  filename: string,
  grantId: string | null,
): Promise<HostExportTargetGrant | null> {
  const { chunkBytes } = EXPORT_TRANSFER_LIMITS;
  if (blob.size <= chunkBytes || !supportsChunkedSave(exports)) {
    if (blob.size > HOST_WIRE_LIMITS.binaryBytes) {
      throw new Error(
        'This export is too large for this version of DocBlocks to save. Update DocBlocks and try again.',
      );
    }
    return exports.save(documentId, filename, grantId, await blob.arrayBuffer());
  }

  // An upload needs its authority before any bytes move, so a save without a
  // remembered target asks for one first — the same picker `save` would show.
  let uploadGrantId = grantId;
  if (!uploadGrantId) {
    const picked = await exports.pickTarget(documentId, filename, null);
    if (!picked?.grantId) return null;
    uploadGrantId = picked.grantId;
  }

  const transferId = await exports.beginSave(documentId, filename, uploadGrantId, blob.size);
  try {
    for (let offset = 0; offset < blob.size; offset += chunkBytes) {
      const chunk = await blob.slice(offset, offset + chunkBytes).arrayBuffer();
      await exports.writeChunk(transferId, offset, chunk);
    }
    return await exports.finishSave(transferId);
  } finally {
    // Idempotent after finishSave; on failure it discards the partial spool.
    await exports.closeTransfer(transferId).catch(() => undefined);
  }
}
