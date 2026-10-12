import type { FileSystemEntry } from '@bendyline/docblocks/filesystem';
import { displayFileName } from './file-names.js';

export type FileExplorerSortMode = 'name' | 'last-modified';

const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Order file and folder names the way people read them: ignoring case, with
 * runs of digits compared as numbers, on the names the lists actually show
 * (Markdown documents without `.md`). A raw code-unit comparison put every
 * capitalised name ahead of every lowercase one, "Invoice 10" ahead of
 * "Invoice 2", and "notes 2" ahead of "notes". Names equal under those rules
 * fall back to an exact comparison, so the order is always deterministic.
 */
export function compareFileNames(left: string, right: string): number {
  return (
    NAME_COLLATOR.compare(displayFileName(left), displayFileName(right)) ||
    NAME_COLLATOR.compare(left, right) ||
    (left < right ? -1 : left > right ? 1 : 0)
  );
}

function modifiedTime(entry: FileSystemEntry): number | null {
  if (entry.kind !== 'file' || !entry.lastModified) return null;
  const timestamp = Date.parse(entry.lastModified);
  return Number.isNaN(timestamp) ? null : timestamp;
}

/**
 * Order one directory's children for presentation in the explorer.
 * Folders always stay first and alphabetical. Files use the selected mode,
 * with name as a deterministic fallback for equal or unavailable timestamps.
 */
export function sortFileEntries(
  entries: readonly FileSystemEntry[],
  mode: FileExplorerSortMode,
): FileSystemEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
    if (left.kind === 'directory' || right.kind === 'directory' || mode === 'name') {
      return compareFileNames(left.name, right.name);
    }

    const leftTime = modifiedTime(left);
    const rightTime = modifiedTime(right);
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    if (leftTime === null && rightTime !== null) return 1;
    if (leftTime !== null && rightTime === null) return -1;
    return compareFileNames(left.name, right.name);
  });
}
