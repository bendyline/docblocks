/**
 * Tasks as the pages show them, derived from the workspace index.
 *
 * Nothing here is stored. A task is whatever the files say right now: a
 * Markdown document inside a tasks folder, or a document elsewhere that
 * carries a due date or a completion stamp.
 */

import type { WorkspacePath } from '@bendyline/docblocks/filesystem';
import {
  locateTask,
  orderBuckets,
  resolveTasksFolder,
  titleOfFileName,
  type KindFolder,
  type TasksFolder,
} from '@bendyline/docblocks/folders';
import {
  compareDue,
  describeDue,
  type ChecklistProgress,
  type DueValue,
  type LocalDate,
  type RepeatRule,
} from '@bendyline/docblocks/properties';
import type { IndexedDocument, IndexedFolderMarker } from '@bendyline/docblocks/workspace-index';

export interface TaskItem {
  readonly workspaceId: string;
  readonly path: WorkspacePath;
  /** A task's name is its file name; a dated document elsewhere keeps its own title. */
  readonly title: string;
  readonly due?: DueValue;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly repeat?: RepeatRule;
  readonly done: boolean;
  /** The day it was finished, when the file says. */
  readonly completedOn?: LocalDate;
  readonly checklist?: ChecklistProgress;
  /** The tasks folder it is in; null for a dated document elsewhere. */
  readonly folder: WorkspacePath | null;
  /** Its bucket in that folder; null at the folder's top level, or outside one. */
  readonly bucket: string | null;
  /** Folders between the bucket and the file. */
  readonly group: string;
  /** Not analyzed yet: its properties are not known. */
  readonly pending: boolean;
  readonly lastModified: string;
}

/**
 * The folders whose settings can be relied on. One whose settings could not
 * be re-read keeps the kind it last had: a failed read is not a reason to
 * stop treating a tasks folder as one.
 */
export function kindFoldersFromMarkers(markers: readonly IndexedFolderMarker[]): KindFolder[] {
  const folders: KindFolder[] = [];
  for (const marker of markers) {
    if ((marker.status === 'ok' || marker.status === 'unreadable') && marker.settings) {
      folders.push({ path: marker.path, settings: marker.settings });
    }
  }
  return folders;
}

/** The task a document is, or null when it is not one. */
export function taskItemOf(
  workspaceId: string,
  document: IndexedDocument,
  folders: readonly KindFolder[],
): TaskItem | null {
  if (document.format !== 'markdown') return null;
  const location = locateTask(folders, document.path);
  if (!location && document.due === undefined && document.completed === undefined) return null;
  const done = location ? location.placement.done : document.completed !== undefined;
  return {
    workspaceId,
    path: document.path,
    title: location ? titleOfFileName(document.path) : document.title,
    ...(document.due ? { due: document.due } : {}),
    ...(document.category ? { category: document.category } : {}),
    ...(document.tags?.length ? { tags: document.tags } : {}),
    ...(document.repeat ? { repeat: document.repeat } : {}),
    done,
    ...(typeof document.completed === 'string' ? { completedOn: document.completed } : {}),
    ...(document.checklist ? { checklist: document.checklist } : {}),
    folder: location?.folder.path ?? null,
    bucket: location?.placement.bucket ?? null,
    group: location?.placement.group ?? '',
    pending: document.issue === 'pending',
    lastModified: document.lastModified,
  };
}

/** Every task among a workspace's documents. */
export function taskItemsFromDocuments(
  workspaceId: string,
  documents: readonly IndexedDocument[],
  folders: readonly KindFolder[],
): TaskItem[] {
  const items: TaskItem[] = [];
  for (const document of documents) {
    const item = taskItemOf(workspaceId, document, folders);
    if (item) items.push(item);
  }
  return items;
}

/** Soonest first; tasks with no date after those with one; then by name. */
export function compareTasks(left: TaskItem, right: TaskItem): number {
  if (left.due && right.due) {
    const byDue = compareDue(left.due, right.due);
    if (byDue !== 0) return byDue;
  } else if (left.due || right.due) {
    return left.due ? -1 : 1;
  }
  return (
    left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: 'base' }) ||
    (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  );
}

/** Most recently finished first; those with no date by when the file last changed. */
export function compareFinished(left: TaskItem, right: TaskItem): number {
  const leftWhen = left.completedOn ?? left.lastModified.slice(0, 10);
  const rightWhen = right.completedOn ?? right.lastModified.slice(0, 10);
  if (leftWhen !== rightWhen) return leftWhen < rightWhen ? 1 : -1;
  return compareTasks(left, right);
}

export interface TaskSections {
  readonly overdue: readonly TaskItem[];
  readonly today: readonly TaskItem[];
  readonly upcoming: readonly TaskItem[];
  readonly undated: readonly TaskItem[];
  readonly done: readonly TaskItem[];
}

/** Tasks sorted into what needs attention, each section in order. */
export function sectionTasks(items: readonly TaskItem[], today: LocalDate): TaskSections {
  const overdue: TaskItem[] = [];
  const dueToday: TaskItem[] = [];
  const upcoming: TaskItem[] = [];
  const undated: TaskItem[] = [];
  const done: TaskItem[] = [];
  for (const item of items) {
    if (item.done) done.push(item);
    else if (!item.due) undated.push(item);
    else {
      const { status } = describeDue(item.due, today);
      (status === 'overdue' ? overdue : status === 'today' ? dueToday : upcoming).push(item);
    }
  }
  return {
    overdue: overdue.sort(compareTasks),
    today: dueToday.sort(compareTasks),
    upcoming: upcoming.sort(compareTasks),
    undated: undated.sort(compareTasks),
    done: done.sort(compareFinished),
  };
}

export interface BoardColumn {
  /** The bucket's folder name; null for tasks at the tasks folder's top level. */
  readonly bucket: string | null;
  readonly done: boolean;
  /** False for a default bucket that has no folder yet. */
  readonly exists: boolean;
  readonly items: readonly TaskItem[];
}

export interface TaskBoard {
  readonly folder: TasksFolder;
  readonly columns: readonly BoardColumn[];
  /** Open tasks, counting every column that is not done. */
  readonly openCount: number;
}

/**
 * The board for one tasks folder. `directories` are the workspace's folders
 * (from the index); the tasks folder's own subfolders become the columns,
 * whether or not they hold a task yet.
 */
export function buildTaskBoard(
  kindFolder: KindFolder,
  directories: readonly string[],
  items: readonly TaskItem[],
): TaskBoard {
  const folder = resolveTasksFolder(kindFolder.path, kindFolder.settings);
  const prefix = folder.path ? `${folder.path}/` : '';
  const subfolders = directories
    .filter((path) => path.startsWith(prefix) && path.length > prefix.length)
    .map((path) => path.slice(prefix.length))
    .filter((relative) => !relative.includes('/'))
    // Extra buckets read in name order, however the listing arrived.
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const mine = items.filter((item) => item.folder === folder.path);
  const inBucket = (bucket: string | null) => mine.filter((item) => item.bucket === bucket);

  const columns: BoardColumn[] = [];
  const loose = inBucket(null);
  if (loose.length > 0) {
    columns.push({ bucket: null, done: false, exists: true, items: loose.sort(compareTasks) });
  }
  for (const bucket of orderBuckets(folder, subfolders)) {
    columns.push({
      bucket: bucket.name,
      done: bucket.done,
      exists: bucket.exists,
      items: inBucket(bucket.name).sort(bucket.done ? compareFinished : compareTasks),
    });
  }
  return {
    folder,
    columns,
    openCount: columns.reduce((sum, column) => sum + (column.done ? 0 : column.items.length), 0),
  };
}

/** How a due date reads on a task row: "Today", "Tomorrow", "Fri 27 Nov", "2 days late". */
export function dueLabel(
  due: DueValue,
  today: LocalDate,
  locale?: string,
): { readonly text: string; readonly status: 'overdue' | 'today' | 'tomorrow' | 'upcoming' } {
  const { status, days } = describeDue(due, today);
  const time = due.length > 10 ? `, ${due.slice(11, 16)}` : '';
  if (status === 'today') return { text: `Today${time}`, status };
  if (status === 'tomorrow') return { text: `Tomorrow${time}`, status };
  if (status === 'overdue') {
    return { text: days === -1 ? 'Yesterday' : `${-days} days late`, status };
  }
  const [year, month, day] = due.slice(0, 10).split('-').map(Number) as [number, number, number];
  const instant = new Date(Date.UTC(year, month - 1, day));
  const sameYear = today.slice(0, 4) === due.slice(0, 4);
  const text = new Intl.DateTimeFormat(locale, {
    weekday: days < 7 ? 'short' : undefined,
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : 'numeric',
    timeZone: 'UTC',
  }).format(instant);
  return { text: `${text}${time}`, status };
}

/** Where a task lives, for a list that gathers tasks from several folders. */
export function taskWhere(item: Pick<TaskItem, 'path'>): string {
  const folder = item.path.slice(0, item.path.lastIndexOf('/'));
  return folder ? folder.split('/').join(' › ') : 'Top of the workspace';
}

const CATEGORY_HUES = ['green', 'blue', 'violet', 'amber', 'rose', 'teal'] as const;
export type CategoryHue = (typeof CATEGORY_HUES)[number];

/**
 * The colour a category is shown in. Derived from its name, so the same
 * category has the same colour in every workspace and on every device with
 * nothing to configure or sync.
 */
export function categoryHue(category: string): CategoryHue {
  const name = category.normalize('NFC').trim().toLowerCase();
  // FNV-1a: small, stable, and spreads short names well.
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return CATEGORY_HUES[(hash >>> 0) % CATEGORY_HUES.length]!;
}
