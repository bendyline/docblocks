/**
 * Extension-to-MIME mapping shared by the ContentContainer implementations.
 *
 * Both containers describe the same workspace media files, so a format that
 * only one of them recognises would report a different `mimeType` depending on
 * whether the workspace happens to be IndexedDB- or filesystem-backed.
 */

const EXTENSION_MIME_MAP: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

/** Best-effort MIME type from a path's extension. */
export function guessMimeType(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = path.slice(dot).toLowerCase();
  return EXTENSION_MIME_MAP[ext] ?? 'application/octet-stream';
}
