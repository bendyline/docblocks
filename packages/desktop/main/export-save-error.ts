import path from 'node:path';

const TARGET_UNAVAILABLE_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

/**
 * Translate expected native write failures into an actionable, path-safe
 * message. Unexpected failures retain their original diagnostic details.
 */
export function exportSaveErrorMessage(error: unknown, targetPath: string): string | null {
  const code = nodeErrorCode(error);
  const filename = path.basename(targetPath);

  if (code && TARGET_UNAVAILABLE_CODES.has(code)) {
    return (
      `Couldn't save "${filename}". It may be open in another app, or you may not have ` +
      'permission to replace it. Close the file and try again, or choose a different export ' +
      'location.'
    );
  }

  if (code === 'ENOSPC') {
    return (
      `There isn't enough space to save "${filename}". Free up some space or choose a ` +
      'different export location.'
    );
  }

  if (code === 'EROFS') {
    return (
      `Couldn't save "${filename}" because the destination is read-only. ` +
      'Choose a different export location.'
    );
  }

  return null;
}

function nodeErrorCode(error: unknown): string | null {
  if (!(error instanceof Error) || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}
