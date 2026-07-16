import { FsError, type FsOperation } from './fs-error.js';

export interface DecodeUtf8TextOptions {
  /** User-facing description of the payload being decoded. */
  readonly label?: string;
  /** Filesystem operation that produced the bytes. */
  readonly operation?: FsOperation;
  /** Canonical or display path associated with the payload. */
  readonly path?: string;
}

/**
 * Decode byte-authoritative text without silently replacing malformed input.
 * Replacement characters are unsafe at persistence boundaries because a later
 * save can permanently overwrite the original bytes with altered content.
 */
export function decodeUtf8Text(
  data: ArrayBuffer | ArrayBufferView,
  options: DecodeUtf8TextOptions = {},
): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new FsError('corrupt', `${options.label ?? 'Text content'} is not valid UTF-8.`, {
      operation: options.operation ?? 'read',
      path: options.path,
    });
  }
}
