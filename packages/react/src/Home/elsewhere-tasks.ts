/**
 * Ticking off a task in a workspace that is not open, from Home or the Tasks
 * page. Those rows come from the workspace's saved digest, so the task is
 * finished (or reopened) straight on that workspace's storage, by the same
 * operations as an open workspace's, and the digest is then amended so the
 * row, the counts and the reminders follow at once rather than at the next
 * background read.
 *
 * The task's folder settings are read from storage first: the digest knows
 * where a tasks folder is, not which buckets it treats as done.
 */

import {
  getFileSystemProviderV2,
  type FileSystemProvider,
  type WorkspacePath,
} from '@bendyline/docblocks/filesystem';
import {
  placeTask,
  readFolderSettings,
  resolveTasksFolder,
  type TasksFolder,
} from '@bendyline/docblocks/folders';
import type { DueValue, LocalDate } from '@bendyline/docblocks/properties';
import { completeTask, createProviderTaskGateway, reopenTask } from '../Tasks/task-operations.js';
import type { TaskItem } from '../Tasks/task-model.js';
import type { HomeDigest } from './home-digest.js';

/** What changed when a task in another workspace was ticked or unticked. */
export interface ElsewhereToggle {
  /** Where the task is now. */
  readonly path: WorkspacePath;
  readonly done: boolean;
  /** The next occurrence a repeating task left in its place. */
  readonly next: { readonly path: WorkspacePath; readonly due: DueValue } | null;
  /** The task's tasks folder as its settings say now; null for a dated document elsewhere. */
  readonly folder: TasksFolder | null;
}

/**
 * The tasks folder `item` is in, from the settings in storage now. A folder
 * whose marker is gone, or is one this version does not understand, is an
 * ordinary folder: its task is stamped and left where it is. A marker that
 * cannot be read at the moment keeps the folder a tasks folder, with the
 * default buckets.
 */
async function tasksFolderNow(
  provider: FileSystemProvider,
  item: TaskItem,
): Promise<TasksFolder | null> {
  if (item.folder === null) return null;
  const v2 = getFileSystemProviderV2(provider);
  if (!v2) return null;
  const observed = await readFolderSettings(v2, item.folder);
  if (observed.status === 'ready') {
    return observed.settings?.kind === 'tasks'
      ? resolveTasksFolder(item.folder, observed.settings)
      : null;
  }
  if (observed.status === 'error') return resolveTasksFolder(item.folder, {});
  return null;
}

/** Finish `item` when it is open, reopen it when it is done. */
export async function toggleTaskElsewhere(
  provider: FileSystemProvider,
  item: TaskItem,
  today: LocalDate,
): Promise<ElsewhereToggle> {
  const gateway = createProviderTaskGateway(provider);
  const folder = await tasksFolderNow(provider, item);
  if (item.done) {
    const path = await reopenTask(gateway, folder, item.path);
    return { path, done: false, next: null, folder };
  }
  const done = await completeTask(gateway, folder, item.path, today);
  return {
    path: done.path,
    done: true,
    next: done.next && done.nextDue ? { path: done.next, due: done.nextDue } : null,
    folder,
  };
}

function placed(item: TaskItem, folder: TasksFolder | null, path: WorkspacePath): TaskItem {
  const placement = folder ? placeTask(folder, path) : null;
  return {
    ...item,
    path,
    ...(placement ? { bucket: placement.bucket, group: placement.group } : {}),
  };
}

function withoutCompletion(item: TaskItem): TaskItem {
  const { completedOn: _completedOn, ...rest } = item;
  return rest;
}

/** The digest as it reads after `change`, made `now`, without reading the workspace again. */
export function amendDigestAfterToggle(
  digest: HomeDigest,
  item: TaskItem,
  change: ElsewhereToggle,
  today: LocalDate,
  now: Date,
): HomeDigest {
  const lastModified = now.toISOString();
  const moved: TaskItem = {
    ...placed(withoutCompletion(item), change.folder, change.path),
    done: change.done,
    ...(change.done ? { completedOn: today } : {}),
    lastModified,
  };
  const items = digest.items.filter(
    (candidate) =>
      candidate.path !== item.path &&
      candidate.path !== change.path &&
      candidate.path !== change.next?.path,
  );
  items.push(moved);
  if (change.next) {
    const { checklist } = item;
    items.push({
      ...placed(withoutCompletion(item), change.folder, change.next.path),
      due: change.next.due,
      done: false,
      ...(checklist ? { checklist: { done: 0, total: checklist.total } } : {}),
      lastModified,
    });
  }
  return { ...digest, items };
}
