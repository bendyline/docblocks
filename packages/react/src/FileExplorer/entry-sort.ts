import type { FileSystemEntry } from '@bendyline/docblocks/filesystem';

export type FileExplorerSortMode = 'name' | 'last-modified';

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
      return compareText(left.name, right.name);
    }

    const leftTime = modifiedTime(left);
    const rightTime = modifiedTime(right);
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    if (leftTime === null && rightTime !== null) return 1;
    if (leftTime !== null && rightTime === null) return -1;
    return compareText(left.name, right.name);
  });
}
