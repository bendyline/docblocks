/**
 * Whether a folder holds anything the tree would show, so a folder with
 * nothing in it can go without a disclosure chevron that opens onto nothing.
 *
 * Two sources know: the tree's own listing of a folder, once it has read one,
 * and the workspace index, which lists the whole workspace from metadata and
 * follows its changes. Either can be behind the other, so a folder counts as
 * empty only when one of them says so and neither has seen anything in it.
 * Anything less certain keeps the chevron; clicking a folder lists it anyway,
 * so a wrong "empty" mends itself on the first click.
 */

import {
  isBrowsableWorkspaceEntry,
  parseWorkspacePath,
  type FileSystemEntry,
} from '@bendyline/docblocks/filesystem';
import type { WorkspaceIndex } from '@bendyline/docblocks/workspace-index';

/** What one source knows about a folder's visible contents. */
export type FolderContents = 'some' | 'none' | 'unknown';

/** True only when a source knows the folder is empty and none has seen anything in it. */
export function folderLooksEmpty(...sources: readonly FolderContents[]): boolean {
  if (sources.includes('some')) return false;
  return sources.includes('none');
}

/**
 * What the tree's own listing says, given the entries of it the tree shows;
 * `unknown` until it has read one.
 */
export function listedFolderContents(
  visibleListing: readonly FileSystemEntry[] | undefined,
): FolderContents {
  if (visibleListing === undefined) return 'unknown';
  return visibleListing.length > 0 ? 'some' : 'none';
}

/**
 * A name the index would list if it were there. Asking about it is how this
 * asks whether the index can vouch for a folder's contents: `has` answers
 * `unknown` beneath a folder it could not read, before its first full
 * listing, and once a listing was cut short.
 */
const PROBE_NAME = 'docblocks-folder-probe.md';

function comparablePath(path: string): string {
  return path.replace(/^\/+/, '').toLowerCase();
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * What the workspace index knows, folder by folder, as of the index's current
 * state. Read it again after the index publishes a change. `hiddenPaths` are
 * the files the tree leaves out (any case), which do not count as contents.
 */
export function indexFolderContents(
  index: Pick<WorkspaceIndex, 'getFiles' | 'getDirectories' | 'has'>,
  hiddenPaths: readonly string[] = [],
): (folder: string) => FolderContents {
  let occupied: Set<string> | null = null;
  const occupiedFolders = (): Set<string> => {
    if (occupied) return occupied;
    const hidden = new Set(hiddenPaths.map(comparablePath));
    occupied = new Set();
    for (const file of index.getFiles()) {
      if (!isBrowsableWorkspaceEntry(file.name, 'file')) continue;
      if (hidden.has(comparablePath(file.path))) continue;
      occupied.add(parentOf(file.path));
    }
    for (const directory of index.getDirectories()) {
      if (directory === '' || !isBrowsableWorkspaceEntry(nameOf(directory), 'directory')) continue;
      occupied.add(parentOf(directory));
    }
    return occupied;
  };

  return (folder) => {
    let canonical: string;
    try {
      canonical = parseWorkspacePath(folder);
    } catch {
      return 'unknown';
    }
    if (canonical === '' || index.has(canonical) !== 'present') return 'unknown';
    if (occupiedFolders().has(canonical)) return 'some';
    return index.has(`${canonical}/${PROBE_NAME}`) === 'unknown' ? 'unknown' : 'none';
  };
}
