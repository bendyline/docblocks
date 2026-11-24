/**
 * What can be done to a task, as file operations.
 *
 * A task is a Markdown file. Finishing one writes `completed` into its
 * frontmatter and, in a tasks folder, moves it to the done bucket; nothing
 * else records the change. The operations run against a small gateway, so
 * the same code serves a document that is open in the editor (which must be
 * changed through its session), a closed one in the active workspace, and
 * one in a workspace that is not open at all.
 */

import {
  FsError,
  getFileSystemProviderV2,
  moveFileSystemEntry,
  parseWorkspacePath,
  workspacePathBasename,
  workspacePathDirname,
  workspacePathJoin,
  type FileSystemProvider,
  type WorkspacePath,
} from '@bendyline/docblocks/filesystem';
import {
  completedTaskPath,
  markdownFileNameForTitle,
  newTaskPath,
  numberedFileName,
  placeTask,
  reopenedTaskPath,
  taskPathInBucket,
  isDoneBucket,
  type TasksFolder,
} from '@bendyline/docblocks/folders';
import {
  applyDocumentProperties,
  nextOccurrence,
  readDocumentProperties,
  type DocumentPropertiesPatch,
  type DueValue,
  type LocalDate,
  type RepeatRule,
} from '@bendyline/docblocks/properties';

/** How task operations reach documents. Paths are workspace paths, with or without a leading slash. */
export interface TaskGateway {
  /** A document's Markdown source, or null when it does not exist. */
  read(path: string): Promise<string | null>;
  /**
   * Replace a document's source with `transform(source)`. Does nothing when
   * the transform returns the source unchanged. Rejects when the document is
   * gone.
   */
  rewrite(path: string, transform: (source: string) => Promise<string>): Promise<void>;
  /** Move a document and what belongs to it. Rejects when the destination exists. */
  move(oldPath: string, newPath: string): Promise<void>;
  /** Create a document. Rejects with an `already-exists` `FsError` when the path is taken. */
  create(path: string, source: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

const MAX_NAME_ATTEMPTS = 200;
const DEFAULT_TASK_NAME = 'Untitled task';

function canonical(path: string): WorkspacePath {
  return parseWorkspacePath(path);
}

/** `path`, or the first numbered sibling of it that is free. */
async function freePath(gateway: TaskGateway, path: WorkspacePath): Promise<WorkspacePath> {
  const folder = workspacePathDirname(path);
  const name = workspacePathBasename(path);
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = workspacePathJoin(folder, numberedFileName(name, attempt));
    if (!(await gateway.exists(candidate))) return candidate;
  }
  throw new Error(`Too many documents are already named like "${name}".`);
}

/** Create at `path`, or at a numbered sibling when another writer took the name first. */
async function createFree(
  gateway: TaskGateway,
  path: WorkspacePath,
  source: string,
): Promise<WorkspacePath> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = await freePath(gateway, path);
    try {
      await gateway.create(candidate, source);
      return candidate;
    } catch (error: unknown) {
      if (!(error instanceof FsError && error.code === 'already-exists')) throw error;
    }
  }
  throw new Error('Could not find a free name for the new task.');
}

export interface NewTask {
  /** What was typed; cleaned into the file name. */
  readonly title: string;
  readonly due?: DueValue;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly repeat?: RepeatRule;
  /** Bucket to put it in; the tasks folder's default when left out, its top level for null. */
  readonly bucket?: string | null;
  /** Markdown body. */
  readonly body?: string;
}

/** Create a task in `folder`. Returns the path it was given. */
export async function createTask(
  gateway: TaskGateway,
  folder: TasksFolder,
  task: NewTask,
): Promise<WorkspacePath> {
  const fileName = markdownFileNameForTitle(task.title, DEFAULT_TASK_NAME);
  const path = newTaskPath(
    folder,
    fileName,
    task.bucket === undefined ? folder.defaultFolder : task.bucket,
  );
  const source = await applyDocumentProperties(task.body ?? '', {
    ...(task.due ? { due: task.due } : {}),
    ...(task.category ? { category: task.category } : {}),
    ...(task.tags?.length ? { tags: task.tags } : {}),
    ...(task.repeat ? { repeat: task.repeat } : {}),
  });
  return createFree(gateway, path, source);
}

/** Change a document's properties in place. */
export async function setTaskProperties(
  gateway: TaskGateway,
  path: string,
  patch: DocumentPropertiesPatch,
): Promise<void> {
  await gateway.rewrite(path, (source) => applyDocumentProperties(source, patch));
}

const TICKED_ITEM = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[[xX]\](?=\s)/gm;

/** A fresh copy of a finished repeating task: nothing ticked, due again. */
async function nextRepeatSource(source: string, due: DueValue): Promise<string> {
  const cleared = source.replace(TICKED_ITEM, '$1[ ]');
  return applyDocumentProperties(cleared, { due, completed: null });
}

async function frontmatterOf(source: string): Promise<Record<string, unknown> | undefined> {
  const { parseMarkdown } = await import('@bendyline/squisq/markdown');
  // Only the leading block matters; the body can be any size.
  const end = source.startsWith('---') ? source.indexOf('\n---', 3) : -1;
  if (end < 0) return undefined;
  return parseMarkdown(`${source.slice(0, end + 4)}\n`).frontmatter;
}

export interface CompletedTask {
  /** Where the task is now. */
  readonly path: WorkspacePath;
  /** The next occurrence, when the task repeats. */
  readonly next: WorkspacePath | null;
  /** When the next occurrence is due; present with `next`. */
  readonly nextDue?: DueValue;
}

/**
 * Finish a task. `folder` is its tasks folder, or null for a dated document
 * elsewhere, which is stamped and stays where it is.
 *
 * The stamp is written before the move. If the move then fails the task is
 * still open (in a tasks folder the bucket decides), and finishing it again
 * completes the job.
 */
export async function completeTask(
  gateway: TaskGateway,
  folder: TasksFolder | null,
  path: string,
  today: LocalDate,
): Promise<CompletedTask> {
  const from = canonical(path);
  const before = await gateway.read(from);
  if (before === null) throw new Error('That task is no longer there.');
  const properties = readDocumentProperties(await frontmatterOf(before));

  await gateway.rewrite(from, (source) => applyDocumentProperties(source, { completed: today }));

  let to = from;
  if (folder && placeTask(folder, from)) {
    const target = completedTaskPath(folder, from);
    if (target !== from) {
      to = await freePath(gateway, target);
      await gateway.move(from, to);
    }
  }

  if (properties.repeat) {
    const due = nextOccurrence(properties.due ?? today, properties.repeat, today);
    // Back where the finished one was, under its own name.
    const next = await createFree(gateway, from, await nextRepeatSource(before, due));
    return { path: to, next, nextDue: due };
  }
  return { path: to, next: null };
}

/** Reopen a finished task: clear the stamp and, in a tasks folder, return it to the default bucket. */
export async function reopenTask(
  gateway: TaskGateway,
  folder: TasksFolder | null,
  path: string,
): Promise<WorkspacePath> {
  const from = canonical(path);
  await gateway.rewrite(from, (source) => applyDocumentProperties(source, { completed: null }));
  if (!folder || !placeTask(folder, from)) return from;
  const target = reopenedTaskPath(folder, from);
  if (target === from) return from;
  const to = await freePath(gateway, target);
  await gateway.move(from, to);
  return to;
}

/**
 * Move a task to another bucket of its tasks folder (`null` for the folder
 * itself). Moving into a done bucket finishes it, repeat included; moving out
 * of one reopens it.
 */
export async function moveTaskToBucket(
  gateway: TaskGateway,
  folder: TasksFolder,
  path: string,
  bucket: string | null,
  today: LocalDate,
): Promise<WorkspacePath> {
  const from = canonical(path);
  const placement = placeTask(folder, from);
  if (!placement) throw new Error('That document is not in this tasks folder.');
  const target = taskPathInBucket(folder, from, bucket);
  if (target === from) return from;
  const toDone = isDoneBucket(folder, bucket);

  if (toDone && !placement.done) {
    // Finish it through the one path that knows about repeats, into the bucket asked for.
    const asked: TasksFolder = {
      ...folder,
      doneFolders: [bucket!, ...folder.doneFolders.filter((name) => name !== bucket)],
    };
    return (await completeTask(gateway, asked, from, today)).path;
  }
  if (!toDone && placement.done) {
    await gateway.rewrite(from, (source) => applyDocumentProperties(source, { completed: null }));
  }
  const to = await freePath(gateway, target);
  await gateway.move(from, to);
  return to;
}

/**
 * A gateway straight onto a workspace's storage, for documents no editor has
 * open. Rewrites are conditional on the version read, and retried once when
 * something else wrote in between, so a sync client's change is never
 * overwritten blind.
 */
export function createProviderTaskGateway(provider: FileSystemProvider): TaskGateway {
  const v2 = getFileSystemProviderV2(provider);
  if (!v2) throw new Error('This workspace cannot be changed from here.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  return {
    async read(path) {
      const file = await v2.readFile(canonical(path));
      return file ? decoder.decode(file.data) : null;
    },
    async rewrite(path, transform) {
      const target = canonical(path);
      for (let attempt = 0; ; attempt += 1) {
        const file = await v2.readFile(target);
        if (!file) throw new Error('That document is no longer there.');
        const source = decoder.decode(file.data);
        const next = await transform(source);
        if (next === source) return;
        try {
          await v2.writeFile(target, encoder.encode(next), {
            mode: 'replace',
            expectedVersion: file.entry.version,
          });
          return;
        } catch (error: unknown) {
          const changedUnderneath = error instanceof FsError && error.code === 'conflict';
          if (!changedUnderneath || attempt >= 1) throw error;
        }
      }
    },
    move: (oldPath, newPath) =>
      moveFileSystemEntry(provider, canonical(oldPath), canonical(newPath), 'file'),
    async create(path, source) {
      await v2.writeFile(canonical(path), encoder.encode(source), {
        mode: 'create',
        createParents: true,
        expectedVersion: null,
      });
    },
    async exists(path) {
      return (await v2.stat(canonical(path))) !== null;
    },
  };
}
