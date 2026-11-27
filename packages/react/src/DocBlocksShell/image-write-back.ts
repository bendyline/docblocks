/**
 * Outside-in image editing: Squisq's `ImageFileEditor` keeps an image
 * file's layers in its hidden `<name.ext>_files/` companion and hands the
 * flattened picture back here to be written over the file itself.
 */

import {
  FsError,
  getFileSystemProviderV2,
  parseWorkspacePath,
  type FileSystemProvider,
} from '@bendyline/docblocks/filesystem';

/** Why the editor is writing the picture back (Squisq's `ImageWriteBackContext`). */
export interface ImageWriteBackContext {
  reason: 'save' | 'leave';
}

export type ImageWriteBack = (
  blob: Blob,
  format: 'png' | 'jpeg' | 'webp',
  context: ImageWriteBackContext,
) => Promise<void>;

export interface ImageWriteBackOptions {
  provider: FileSystemProvider;
  /** The image file the picture is written over. */
  path: string;
  /** The picture is on disk: commit bookkeeping, refresh the open copy. */
  onWritten: (data: ArrayBuffer, mimeType: string) => void;
  /**
   * A write-back while leaving the editor failed. Nothing is on screen to
   * show it, so the shell reports it. A failed Save shows in the editor.
   */
  onLeaveFailed: (message: string) => void;
}

const MIME_TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;

/** Write-back for one image file. Bound to its path, so a late leave still writes the right file. */
export function createImageWriteBack(options: ImageWriteBackOptions): ImageWriteBack {
  const { provider, path, onWritten, onLeaveFailed } = options;
  return async (blob, format, context) => {
    let data: ArrayBuffer;
    try {
      data = await blob.arrayBuffer();
      await writeImageBytes(provider, path, data);
    } catch (error: unknown) {
      const message = `Your changes to “${fileNameOf(path)}” weren’t saved. ${describeWriteError(error)}`;
      if (context.reason === 'leave') onLeaveFailed(message);
      // The editor shows this message as it is, so it carries plain words
      // instead of the storage error.
      throw new Error(message);
    }
    onWritten(data, MIME_TYPES[format]);
  };
}

async function writeImageBytes(
  provider: FileSystemProvider,
  path: string,
  data: ArrayBuffer,
): Promise<void> {
  const v2 = getFileSystemProviderV2(provider);
  if (v2) {
    await v2.writeFile(parseWorkspacePath(path), data, { mode: 'upsert' });
    return;
  }
  await provider.writeBinary(path, data);
}

/** Plain words for a failed write. Never a raw storage message. */
function describeWriteError(error: unknown): string {
  if (error instanceof FsError) {
    switch (error.code) {
      case 'not-found':
        return 'The picture is no longer there.';
      case 'permission-denied':
        return 'DocBlocks isn’t allowed to change it.';
      case 'quota-exceeded':
        return 'There is no room left to save it.';
      default:
        break;
    }
  }
  return 'Try again.';
}

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
