/**
 * The rules of a tasks folder, as pure functions of paths.
 *
 * Inside a tasks folder every Markdown file is a task. The first folder below
 * the tasks folder is its bucket, and a bucket the settings name as done
 * (`Done` unless they say otherwise) means the task is finished; every other
 * place means it is open. Folders deeper than the bucket only group tasks.
 *
 * Status is where the file is, so moving a file in a file manager is a
 * legitimate way to finish a task. Finishing one here moves it to the done
 * bucket and keeps the folders below its bucket, so `Active/House/Paint.md`
 * becomes `Done/House/Paint.md`: links relative to the file stay valid, and
 * reopening puts it back where it was.
 */

import { isCompanionDirectoryName } from '../filesystem/workspace-entry-rules.js';
import {
  parseWorkspacePath,
  workspacePathContains,
  workspacePathJoin,
  type WorkspacePath,
} from '../filesystem/workspace-path.js';
import {
  DEFAULT_TASKS_DONE_FOLDER,
  DEFAULT_TASKS_OPEN_FOLDER,
  sameBucketName,
  type FolderSettings,
} from './folder-settings.js';

/** A tasks folder with its defaults filled in. */
export interface TasksFolder {
  readonly path: WorkspacePath;
  /** Buckets whose tasks are done; never empty. */
  readonly doneFolders: readonly string[];
  /** The bucket new and reopened tasks go to. */
  readonly defaultFolder: string;
}

export function resolveTasksFolder(
  path: WorkspacePath,
  settings: Pick<FolderSettings, 'tasks'>,
): TasksFolder {
  return {
    path,
    doneFolders: settings.tasks?.done?.length ? settings.tasks.done : [DEFAULT_TASKS_DONE_FOLDER],
    defaultFolder: settings.tasks?.default ?? DEFAULT_TASKS_OPEN_FOLDER,
  };
}

export function isDoneBucket(folder: TasksFolder, bucket: string | null): boolean {
  return bucket !== null && folder.doneFolders.some((name) => sameBucketName(name, bucket));
}

/** Where a task sits inside its tasks folder. */
export interface TaskPlacement {
  /** The top-level subfolder it is in; null for a file directly in the tasks folder. */
  readonly bucket: string | null;
  /** Folders between the bucket and the file, `House/Kitchen`; empty when there are none. */
  readonly group: string;
  /** The file name. */
  readonly name: string;
  /** In a bucket that means done. */
  readonly done: boolean;
}

/**
 * Where `documentPath` sits in `folder`, or null when it is not one of its
 * tasks: outside the folder, or inside a document's own `_files` folder.
 */
export function placeTask(folder: TasksFolder, documentPath: WorkspacePath): TaskPlacement | null {
  if (!workspacePathContains(folder.path, documentPath, false)) return null;
  const relative = folder.path ? documentPath.slice(folder.path.length + 1) : documentPath;
  const segments = relative.split('/');
  const name = segments.pop()!;
  // Markdown kept beside a document (a study aid, an outside-in source) is part of that document.
  if (segments.some(isCompanionDirectoryName)) return null;
  const bucket = segments.length > 0 ? segments[0]! : null;
  return {
    bucket,
    group: segments.slice(1).join('/'),
    name,
    done: isDoneBucket(folder, bucket),
  };
}

function pathIn(
  folder: TasksFolder,
  bucket: string | null,
  placement: TaskPlacement,
): WorkspacePath {
  const parts = [bucket, placement.group, placement.name].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  return workspacePathJoin(folder.path, parts.join('/'));
}

/**
 * The path a task has in another bucket, keeping its group folders and name.
 * `bucket` null means directly in the tasks folder. Returns the same path
 * when it is already there.
 */
export function taskPathInBucket(
  folder: TasksFolder,
  documentPath: WorkspacePath,
  bucket: string | null,
): WorkspacePath {
  const placement = placeTask(folder, documentPath);
  if (!placement) throw new RangeError('That document is not in this tasks folder.');
  if (
    placement.bucket === bucket ||
    (placement.bucket !== null && bucket !== null && sameBucketName(placement.bucket, bucket))
  ) {
    return documentPath;
  }
  return pathIn(folder, bucket, placement);
}

/** Where a task goes when it is finished: the first done bucket. */
export function completedTaskPath(folder: TasksFolder, documentPath: WorkspacePath): WorkspacePath {
  const placement = placeTask(folder, documentPath);
  if (!placement) throw new RangeError('That document is not in this tasks folder.');
  if (placement.done) return documentPath;
  return pathIn(folder, folder.doneFolders[0]!, placement);
}

/** Where a finished task goes when it is reopened: the default bucket. */
export function reopenedTaskPath(folder: TasksFolder, documentPath: WorkspacePath): WorkspacePath {
  const placement = placeTask(folder, documentPath);
  if (!placement) throw new RangeError('That document is not in this tasks folder.');
  if (!placement.done) return documentPath;
  return pathIn(folder, folder.defaultFolder, placement);
}

/** Where a new task named `fileName` goes: the default bucket, or the one asked for. */
export function newTaskPath(
  folder: TasksFolder,
  fileName: string,
  bucket: string | null = folder.defaultFolder,
): WorkspacePath {
  const name = parseWorkspacePath(fileName);
  if (!name || name.includes('/')) throw new RangeError('A task needs a single file name.');
  return workspacePathJoin(folder.path, bucket ? `${bucket}/${name}` : name);
}

/**
 * Whether a task is done. In a tasks folder the bucket decides, whatever the
 * frontmatter says: a file dragged out of Done is open again. Elsewhere a
 * document is done when it carries `completed`.
 */
export function isTaskDone(
  placement: TaskPlacement | null,
  properties: { readonly completed?: unknown },
): boolean {
  return placement ? placement.done : properties.completed !== undefined;
}

/**
 * The bucket columns of a tasks folder, in display order: the default bucket,
 * the other open ones as listed, then the done ones. `folders` are the names
 * of the tasks folder's own subfolders; a document's `_files` folder is not a
 * bucket. The default and first done buckets are shown even before they exist.
 */
export function orderBuckets(
  folder: TasksFolder,
  folders: readonly string[],
): readonly { readonly name: string; readonly done: boolean; readonly exists: boolean }[] {
  const present = folders.filter(
    (name) => !isCompanionDirectoryName(name) && !name.startsWith('.'),
  );
  const find = (wanted: string) => present.find((name) => sameBucketName(name, wanted));
  const open = present.filter(
    (name) => !isDoneBucket(folder, name) && !sameBucketName(name, folder.defaultFolder),
  );
  const done = present.filter((name) => isDoneBucket(folder, name));
  const firstDone = folder.doneFolders[0]!;
  return [
    {
      name: find(folder.defaultFolder) ?? folder.defaultFolder,
      done: false,
      exists: find(folder.defaultFolder) !== undefined,
    },
    ...open.map((name) => ({ name, done: false, exists: true })),
    ...(done.length > 0
      ? done.map((name) => ({ name, done: true, exists: true }))
      : [{ name: firstDone, done: true, exists: false }]),
  ];
}
