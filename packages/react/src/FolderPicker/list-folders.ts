/**
 * Every folder of a workspace a document could be put in, read from its
 * storage, for a workspace the picker has no index of (any but the open one).
 * Read from metadata alone: no file is opened, and an online-only one is
 * never downloaded. Hidden, companion and support folders are neither listed
 * nor entered (`isDestinationFolderName`).
 */

import {
  FsError,
  getFileSystemProviderV2,
  isDestinationFolderName,
  parseWorkspacePath,
  type FileSystemProvider,
  type FileSystemProviderV2,
} from '@bendyline/docblocks/filesystem';
import { isDestinationPath } from './folder-tree.js';

export interface ListFoldersOptions {
  /** Stop after this many folders; what was found is still answered. */
  readonly limit?: number;
  /** Stop after this long, likewise. */
  readonly budgetMs?: number;
  readonly now?: () => number;
}

export interface ListedFolders {
  readonly paths: readonly string[];
  /** Stopped at the limit or the budget before every folder was seen. */
  readonly partial: boolean;
}

const DEFAULT_LIMIT = 5_000;
const DEFAULT_BUDGET_MS = 15_000;

async function enumerateFolders(
  storage: FileSystemProviderV2,
  keep: (path: string) => boolean,
): Promise<boolean> {
  if (!storage.enumerate) return false;
  try {
    for await (const page of storage.enumerate(parseWorkspacePath(''))) {
      for (const entry of page.entries) {
        if (entry.kind === 'directory' && isDestinationPath(entry.path) && !keep(entry.path))
          return true;
      }
    }
    return true;
  } catch (error: unknown) {
    // An older host bridge says so from its first page; walk instead.
    if (error instanceof FsError && error.code === 'not-supported') return false;
    throw error;
  }
}

async function walkFolders(
  storage: FileSystemProviderV2,
  keep: (path: string) => boolean,
): Promise<void> {
  const queue = [parseWorkspacePath('')];
  for (let folder = queue.shift(); folder !== undefined; folder = queue.shift()) {
    let entries;
    try {
      entries = await storage.readDirectory(folder);
    } catch {
      // A folder that cannot be read keeps its name in the tree, not its contents.
      continue;
    }
    for (const entry of entries) {
      // Never entered: nothing inside one of these is offered either.
      if (entry.kind !== 'directory' || !isDestinationFolderName(entry.name)) continue;
      if (!keep(entry.path)) return;
      queue.push(entry.path);
    }
  }
}

/** The folders of the workspace `provider` stores, top-down. */
export async function listProviderFolders(
  provider: FileSystemProvider,
  options: ListFoldersOptions = {},
): Promise<ListedFolders> {
  const storage = getFileSystemProviderV2(provider);
  if (!storage) return { paths: [], partial: false };
  const limit = options.limit ?? DEFAULT_LIMIT;
  const now = options.now ?? (() => Date.now());
  const deadline = now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
  const paths: string[] = [];
  let partial = false;
  /** Keep a folder; false once there is no room or time for more. */
  const keep = (path: string): boolean => {
    if (paths.length >= limit || now() > deadline) {
      partial = true;
      return false;
    }
    paths.push(path);
    return true;
  };
  if (!(await enumerateFolders(storage, keep))) await walkFolders(storage, keep);
  return { paths, partial };
}
