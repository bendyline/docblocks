/**
 * Which kind folder a path belongs to. Kind folders can nest (a journal kept
 * inside a tasks folder, say); a path belongs to the nearest one above it.
 */

import { workspacePathContains, type WorkspacePath } from '../filesystem/workspace-path.js';
import type { FolderKind, FolderSettings } from './folder-settings.js';
import { placeTask, resolveTasksFolder, type TaskPlacement, type TasksFolder } from './tasks.js';

/** A folder with valid settings of a kind this version knows. */
export interface KindFolder {
  readonly path: WorkspacePath;
  readonly settings: FolderSettings;
}

/**
 * The kind folder `path` is in: the deepest one that contains it. With
 * `inclusive`, a kind folder's own path counts (for asking what a folder is).
 */
export function kindFolderFor(
  folders: Iterable<KindFolder>,
  path: WorkspacePath,
  inclusive = false,
): KindFolder | null {
  let nearest: KindFolder | null = null;
  for (const folder of folders) {
    if (!workspacePathContains(folder.path, path, inclusive)) continue;
    if (nearest === null || folder.path.length > nearest.path.length) nearest = folder;
  }
  return nearest;
}

/** The kind folders of one kind, by path. */
export function kindFoldersOf(folders: Iterable<KindFolder>, kind: FolderKind): KindFolder[] {
  return [...folders]
    .filter((folder) => folder.settings.kind === kind)
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** A document's place as a task: its tasks folder and where it sits in it. */
export interface TaskLocation {
  readonly folder: TasksFolder;
  readonly placement: TaskPlacement;
}

/**
 * Where `documentPath` sits as a task, or null when the nearest kind folder
 * above it is not a tasks folder.
 */
export function locateTask(
  folders: Iterable<KindFolder>,
  documentPath: WorkspacePath,
): TaskLocation | null {
  const nearest = kindFolderFor(folders, documentPath);
  if (!nearest || nearest.settings.kind !== 'tasks') return null;
  const folder = resolveTasksFolder(nearest.path, nearest.settings);
  const placement = placeTask(folder, documentPath);
  return placement ? { folder, placement } : null;
}
