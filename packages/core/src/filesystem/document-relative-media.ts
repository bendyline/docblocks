/**
 * Document-relative media: `shots/a.png` beside `report.md`, as Markdown
 * written by other tools spells it.
 *
 * DocBlocks writes media into the document's `<stem>_files/` sidecar, and
 * `createFileMediaProvider` keeps resolving references there first. These
 * paths are only a read-only fallback for references the sidecar does not
 * hold, so they are confined to media types and never climb above the root
 * they are resolved within.
 */

import { guessMimeType } from './internal/mime.js';
import { tryParseWorkspacePath, type WorkspacePath } from './workspace-path.js';

/**
 * True when a path names an image, audio, or video file the containers can
 * type by extension -- the only files a document-relative fallback may read.
 */
export function isDocumentMediaPath(path: string): boolean {
  return /^(?:image|audio|video)\//.test(guessMimeType(path));
}

/**
 * Resolve a Markdown media reference against the folder that holds the
 * document. Returns the root-relative path, or null when the reference is not
 * a plain relative path (a URL, an absolute or drive-qualified path), names no
 * media type, or climbs above the root.
 */
export function resolveDocumentRelativeMediaPath(
  documentDirectory: string,
  ref: string,
): WorkspacePath | null {
  const directory = tryParseWorkspacePath(documentDirectory);
  if (directory === null) return null;
  const queryAt = ref.search(/[?#]/);
  const raw = (queryAt === -1 ? ref : ref.slice(0, queryAt)).trim();
  // A scheme (`https:`, `data:`) or drive letter (`C:`), or a rooted path.
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || /^[\\/]/.test(raw)) return null;

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A stray `%` is a literal character in a file name.
  }

  const segments = directory ? directory.split('/') : [];
  for (const segment of decoded.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  const resolved = tryParseWorkspacePath(segments.join('/'));
  return resolved && isDocumentMediaPath(resolved) ? resolved : null;
}
