import {
  createDbkWorkspaceSnapshot,
  type DbkWorkspaceSnapshot,
} from '@bendyline/docblocks/filesystem';
import { SHARED_DOCUMENT_LIMITS } from '@bendyline/docblocks/share';
import type { ZipToContainerOptions } from '@bendyline/squisq-formats/container';

const WORKSPACE_DBK_LIMITS = Object.freeze({
  maxEntries: 256,
  maxUncompressedBytes: 16 * 1024 * 1024,
  maxEntryUncompressedBytes: 8 * 1024 * 1024,
  maxCompressionRatio: 200,
}) satisfies ZipToContainerOptions;

const SHARED_DBK_LIMITS = Object.freeze({
  maxEntries: 4,
  maxUncompressedBytes: SHARED_DOCUMENT_LIMITS.markdownBytes,
  maxEntryUncompressedBytes: SHARED_DOCUMENT_LIMITS.markdownBytes,
  // The independent 20 KiB uncompressed cap is authoritative here. Highly
  // repetitive legitimate Markdown can exceed 200:1 while remaining tiny.
  maxCompressionRatio: 1_000,
}) satisfies ZipToContainerOptions;

export interface DecodeDbkWorkspaceOptions {
  targetDocumentPath: string;
  profile?: 'workspace' | 'shared-link';
}

/**
 * Decode an untrusted DBK through Squisq's bounded ZIP reader, then apply the
 * independent DocBlocks Markdown-only/UTF-8 workspace validation pass.
 */
export async function decodeDbkWorkspace(
  bytes: ArrayBuffer | Uint8Array | Blob,
  options: DecodeDbkWorkspaceOptions,
): Promise<DbkWorkspaceSnapshot> {
  const { zipToContainer } = await import('@bendyline/squisq-formats/container');
  const shared = options.profile === 'shared-link';
  const container = await zipToContainer(bytes, shared ? SHARED_DBK_LIMITS : WORKSPACE_DBK_LIMITS);
  const snapshot = await createDbkWorkspaceSnapshot(container, {
    targetDocumentPath: options.targetDocumentPath,
  });
  if (shared && snapshot.files.length !== 1) {
    throw new Error('A shared document link must contain exactly one Markdown file.');
  }
  return snapshot;
}
