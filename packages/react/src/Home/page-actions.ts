/**
 * What the Home, Tasks, Journal and Unfiled pages can do, as one object the
 * shell builds for the active workspace.
 *
 * Everything is a file operation through the task gateway or the workspace's
 * storage, so these run the same on every surface and can be tested over an
 * in-memory workspace. Every action reports its own outcome in plain words;
 * a page only has to call it.
 */

import {
  FsError,
  parseWorkspacePath,
  workspacePathBasename,
  workspacePathJoin,
  type FileSystemProviderV2,
  type WorkspacePath,
} from '@bendyline/docblocks/filesystem';
import {
  DEFAULT_JOURNAL_FOLDER_NAME,
  DEFAULT_TASKS_FOLDER_NAME,
  DEFAULT_UNFILED_FOLDER_NAME,
  checkBucketName,
  defaultFolderSettings,
  findJournalEntry,
  journalEntryMarkdown,
  journalEntryPath,
  kindFolderFor,
  kindFoldersOf,
  markdownFileNameForTitle,
  numberedFileName,
  readFolderSettings,
  removeFolderSettings,
  resolveTasksFolder,
  titleOfFileName,
  writeFolderSettings,
  type FolderKind,
  type KindFolder,
  type TasksFolder,
} from '@bendyline/docblocks/folders';
import {
  localTimeOf,
  parseCapture,
  type DueValue,
  type LocalDate,
} from '@bendyline/docblocks/properties';
import {
  completeTask,
  createTask,
  moveTaskToBucket,
  reopenTask,
  setTaskProperties,
  type TaskGateway,
} from '../Tasks/task-operations.js';
import type { TaskItem } from '../Tasks/task-model.js';

export type PageStorage = Pick<
  FileSystemProviderV2,
  'readFile' | 'writeFile' | 'remove' | 'createDirectory' | 'stat'
>;

export interface PageActionHost {
  readonly gateway: TaskGateway;
  readonly storage: PageStorage;
  /** The folders that say what they are, as the index last saw them. */
  readonly kindFolders: () => readonly KindFolder[];
  /** Every Markdown document's path, as the index last saw them. */
  readonly documentPaths: () => readonly string[];
  readonly today: () => LocalDate;
  readonly now: () => Date;
  readonly confirmDelete: (message: string) => Promise<boolean>;
  readonly report: (kind: 'success' | 'error', message: string) => void;
  /** Something changed at `path` (a folder or file), or anywhere with none. */
  readonly changed: (path?: string) => void;
  readonly openDocument: (path: string) => void;
  readonly openFolder: (path: string) => void;
  /**
   * Keep a version of a document as it is, before an edit the person did not
   * type themselves (one Ask proposed). Absent where versions are not kept.
   * Rejects when the version could not be written, which stops the edit.
   */
  readonly keepVersion?: (path: WorkspacePath, source: string) => Promise<void>;
}

/** A task described field by field, as Ask proposes one. */
export interface DescribedTask {
  readonly title: string;
  readonly due?: DueValue;
  readonly category?: string;
  readonly notes?: string;
}

const KIND_NAMES: Record<
  FolderKind,
  { readonly folder: string; readonly label: string; readonly withArticle: string }
> = {
  tasks: {
    folder: DEFAULT_TASKS_FOLDER_NAME,
    label: 'tasks folder',
    withArticle: 'a tasks folder',
  },
  journal: { folder: DEFAULT_JOURNAL_FOLDER_NAME, label: 'journal', withArticle: 'a journal' },
  unfiled: {
    folder: DEFAULT_UNFILED_FOLDER_NAME,
    label: 'Unfiled drawer',
    withArticle: 'an Unfiled drawer',
  },
};

/** What went wrong, in words a person can act on. Never a raw storage message. */
export function describeActionError(error: unknown): string {
  if (error instanceof FsError) {
    switch (error.code) {
      case 'conflict':
        return 'It changed somewhere else in the meantime. Try again.';
      case 'already-exists':
        return 'Something with that name is already there.';
      case 'not-found':
        return 'It is no longer there.';
      case 'permission-denied':
        return "DocBlocks isn't allowed to change it.";
      case 'quota-exceeded':
        return 'There is no room left to save it.';
      default:
        return 'Something went wrong. Try again.';
    }
  }
  // Only messages this app's own code wrote are in plain words: a plain Error
  // with no system code. Browser and OS errors (TypeError, DOMException,
  // Node's coded errors) are not shown as they are.
  if (
    error instanceof Error &&
    error.constructor === Error &&
    !('code' in error) &&
    error.message
  ) {
    return error.message.length <= 160 ? error.message : 'Something went wrong. Try again.';
  }
  return 'Something went wrong. Try again.';
}

function quoted(text: string): string {
  return `“${text.length > 60 ? `${text.slice(0, 59)}…` : text}”`;
}

function displayFolder(path: string): string {
  return path.replace(/^\/+/, '').split('/').join(' › ') || 'the workspace';
}

/** A note's name: its first line, or its first few words. */
export function noteTitleFor(text: string): string {
  const firstLine =
    text
      .split('\n')
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find(Boolean) ?? '';
  const words = firstLine.split(/\s+/);
  return words.length > 8 ? `${words.slice(0, 8).join(' ')}…` : firstLine;
}

export interface PageActions {
  /** The tasks folder new tasks go to, when there is one. */
  defaultTasksFolder(): TasksFolder | null;
  /**
   * Add a task from typed text ("Call Priya tomorrow"). Without a tasks
   * folder in the workspace, one is set up first. Returns the new path.
   */
  addTask(
    text: string,
    target?: { readonly folder: string; readonly bucket: string | null },
  ): Promise<string | null>;
  complete(item: TaskItem): Promise<void>;
  reopen(item: TaskItem): Promise<void>;
  moveToBucket(item: TaskItem, bucket: string | null): Promise<void>;
  /** Set up the workspace's first folder of `kind`; returns its path. */
  setUp(kind: FolderKind): Promise<string | null>;
  /** Make an existing folder a folder of `kind`. */
  makeKind(folder: string, kind: FolderKind): Promise<void>;
  /**
   * Make a new folder of `kind` in `parent` (`''` for the top of the
   * workspace), named for its kind and numbered past a name already taken,
   * and open it. Unlike `setUp`, this never reuses one that exists: a
   * workspace can keep several task lists. Returns its path.
   */
  createKindFolder(parent: string, kind: FolderKind): Promise<string | null>;
  /** Make a kind folder an ordinary folder again; nothing in it is touched. */
  clearKind(folder: string): Promise<void>;
  addBucket(folder: string, name: string): Promise<boolean>;
  /** Open the journal entry for `date`, creating it when there is none. */
  openJournalDay(folder: string, date: LocalDate): Promise<void>;
  /** Add a timestamped line to today's journal entry. */
  appendToJournal(text: string): Promise<boolean>;
  /** Add a task given field by field, to the default tasks folder. Returns its path. */
  addDescribedTask(task: DescribedTask): Promise<string | null>;
  /** Save typed text as a note in the Unfiled drawer, named `title` when given. */
  saveNote(text: string, title?: string): Promise<string | null>;
  /**
   * Change an existing document, keeping a version of it first where the host
   * keeps versions. `doing` completes "Couldn't …" when it fails. Null when
   * nothing was written.
   */
  editDocument(
    path: string,
    change: (source: string) => string | Promise<string>,
    doing: string,
  ): Promise<{ readonly versionKept: boolean } | null>;
  /** The Unfiled drawer's path, setting it up without a word if there is none. */
  ensureUnfiled(): Promise<string | null>;
  /** Move a document (with what belongs to it) into `folder`. */
  fileTo(path: string, folder: string): Promise<void>;
  /** Move a note into the default tasks folder, which makes it a task. */
  makeTask(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export function createPageActions(host: PageActionHost): PageActions {
  const failed = (doing: string, error: unknown) => {
    host.report('error', `Couldn't ${doing}. ${describeActionError(error)}`);
  };

  const firstOfKind = (kind: FolderKind): KindFolder | null =>
    kindFoldersOf(host.kindFolders(), kind)[0] ?? null;

  const defaultTasksFolder = (): TasksFolder | null => {
    const folder = firstOfKind('tasks');
    return folder ? resolveTasksFolder(folder.path, folder.settings) : null;
  };

  /** The tasks folder of a task, or null for a dated document elsewhere. */
  const tasksFolderOf = (item: TaskItem): TasksFolder | null => {
    if (item.folder === null) return null;
    const folder = host.kindFolders().find((candidate) => candidate.path === item.folder);
    return folder ? resolveTasksFolder(folder.path, folder.settings) : null;
  };

  const freeFolderPath = async (name: string, parent = ''): Promise<WorkspacePath> => {
    const within = parent.replace(/^\/+|\/+$/g, '');
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const folderName = attempt === 1 ? name : `${name} ${attempt}`;
      const candidate = parseWorkspacePath(within ? `${within}/${folderName}` : folderName);
      if ((await host.storage.stat(candidate)) === null) return candidate;
    }
    throw new Error(`Too many folders are already called ${name}.`);
  };

  const ensureDirectory = async (path: WorkspacePath) => {
    try {
      await host.storage.createDirectory(path, { createParents: true });
    } catch (error: unknown) {
      if (!(error instanceof FsError && error.code === 'already-exists')) throw error;
    }
  };

  /** Write a folder's settings and the folders its kind starts with. */
  const markFolder = async (folder: WorkspacePath, kind: FolderKind) => {
    await ensureDirectory(folder);
    const observed = await readFolderSettings(host.storage, folder);
    if (observed.status !== 'missing' && observed.status !== 'ready') {
      throw new Error(observed.message ?? 'This folder has settings DocBlocks cannot change.');
    }
    await writeFolderSettings(host.storage, folder, observed, defaultFolderSettings(kind));
    if (kind === 'tasks') {
      const settings = resolveTasksFolder(folder, {});
      await ensureDirectory(workspacePathJoin(folder, settings.defaultFolder));
      await ensureDirectory(workspacePathJoin(folder, settings.doneFolders[0]!));
    }
    host.changed(folder);
  };

  /** Folders set up here that the index may not have seen yet. */
  const setUpHere = new Map<FolderKind, WorkspacePath>();

  /** A folder of `kind` already set up, by the index or by storage itself. */
  const existingOfKind = async (kind: FolderKind): Promise<WorkspacePath | null> => {
    const known = firstOfKind(kind);
    if (known) return known.path;
    // The index catches up a moment after a write; ask storage meanwhile, so
    // two quick saves never set up two drawers.
    for (const candidate of [setUpHere.get(kind), parseWorkspacePath(KIND_NAMES[kind].folder)]) {
      if (!candidate) continue;
      const settings = await readFolderSettings(host.storage, candidate);
      if (settings.status === 'ready' && settings.settings?.kind === kind) return candidate;
    }
    return null;
  };

  const setUpFolder = async (kind: FolderKind, quietly: boolean): Promise<WorkspacePath> => {
    const existing = await existingOfKind(kind);
    if (existing) return existing;
    const folder = await freeFolderPath(KIND_NAMES[kind].folder);
    await markFolder(folder, kind);
    setUpHere.set(kind, folder);
    if (!quietly)
      host.report('success', `Set up ${displayFolder(folder)} as your ${KIND_NAMES[kind].label}.`);
    return folder;
  };

  const tasksFolderForNewTask = async (): Promise<TasksFolder> => {
    const existing = defaultTasksFolder();
    if (existing) return existing;
    const known = await existingOfKind('tasks');
    if (known) return resolveTasksFolder(known, {});
    const path = await setUpFolder('tasks', true);
    host.report('success', `Set up ${displayFolder(path)} for your tasks.`);
    return resolveTasksFolder(path, {});
  };

  /** A free path for `fileName` in `folder`, numbered when taken. */
  const freeFilePath = async (folder: string, fileName: string): Promise<WorkspacePath> => {
    for (let attempt = 1; attempt <= 200; attempt += 1) {
      const candidate = workspacePathJoin(
        parseWorkspacePath(folder),
        numberedFileName(fileName, attempt),
      );
      if (!(await host.gateway.exists(candidate))) return candidate;
    }
    throw new Error('Too many documents already have that name.');
  };

  return {
    defaultTasksFolder,

    async addTask(text, target) {
      const capture = parseCapture(text, host.today());
      if (!capture.title.trim()) return null;
      try {
        let folder: TasksFolder;
        if (target) {
          const kindFolder = kindFolderFor(
            host.kindFolders(),
            parseWorkspacePath(target.folder),
            true,
          );
          folder =
            kindFolder && kindFolder.settings.kind === 'tasks'
              ? resolveTasksFolder(kindFolder.path, kindFolder.settings)
              : resolveTasksFolder(parseWorkspacePath(target.folder), {});
        } else {
          folder = await tasksFolderForNewTask();
        }
        const path = await createTask(host.gateway, folder, {
          title: capture.title,
          ...(capture.due ? { due: capture.due } : {}),
          bucket: target ? target.bucket : folder.defaultFolder,
        });
        host.changed(path);
        return path;
      } catch (error: unknown) {
        failed(`add ${quoted(capture.title)}`, error);
        return null;
      }
    },

    async complete(item) {
      try {
        const done = await completeTask(host.gateway, tasksFolderOf(item), item.path, host.today());
        host.changed(item.path);
        if (done.path !== item.path) host.changed(done.path);
        if (done.next) {
          host.changed(done.next);
          host.report('success', `Done. ${quoted(item.title)} comes round again.`);
        }
      } catch (error: unknown) {
        failed(`finish ${quoted(item.title)}`, error);
      }
    },

    async reopen(item) {
      try {
        const path = await reopenTask(host.gateway, tasksFolderOf(item), item.path);
        host.changed(item.path);
        if (path !== item.path) host.changed(path);
      } catch (error: unknown) {
        failed(`reopen ${quoted(item.title)}`, error);
      }
    },

    async moveToBucket(item, bucket) {
      const folder = tasksFolderOf(item);
      if (!folder) return;
      try {
        const path = await moveTaskToBucket(host.gateway, folder, item.path, bucket, host.today());
        host.changed(item.path);
        if (path !== item.path) host.changed(path);
      } catch (error: unknown) {
        failed(`move ${quoted(item.title)}`, error);
      }
    },

    async setUp(kind) {
      try {
        const path = await setUpFolder(kind, false);
        host.openFolder(`/${path}`);
        return path;
      } catch (error: unknown) {
        failed(`set up your ${KIND_NAMES[kind].label}`, error);
        return null;
      }
    },

    async makeKind(folder, kind) {
      try {
        const path = parseWorkspacePath(folder);
        await markFolder(path, kind);
        host.report('success', `${displayFolder(path)} is now ${KIND_NAMES[kind].withArticle}.`);
        host.openFolder(`/${path}`);
      } catch (error: unknown) {
        failed(`make ${displayFolder(folder)} ${KIND_NAMES[kind].withArticle}`, error);
      }
    },

    async createKindFolder(parent, kind) {
      try {
        const path = await freeFolderPath(KIND_NAMES[kind].folder, parent);
        await markFolder(path, kind);
        host.report('success', `Set up ${displayFolder(path)} as ${KIND_NAMES[kind].withArticle}.`);
        host.openFolder(`/${path}`);
        return path;
      } catch (error: unknown) {
        failed(`set up ${KIND_NAMES[kind].withArticle}`, error);
        return null;
      }
    },

    async clearKind(folder) {
      try {
        const path = parseWorkspacePath(folder);
        const observed = await readFolderSettings(host.storage, path);
        await removeFolderSettings(host.storage, path, observed);
        host.changed(path);
        host.report(
          'success',
          `${displayFolder(path)} is an ordinary folder again. Nothing in it moved.`,
        );
      } catch (error: unknown) {
        failed(`change ${displayFolder(folder)}`, error);
      }
    },

    async addBucket(folder, name) {
      const trimmed = name.trim();
      const problem = checkBucketName(trimmed);
      if (problem) {
        host.report('error', problem);
        return false;
      }
      try {
        const path = workspacePathJoin(parseWorkspacePath(folder), trimmed);
        await host.storage.createDirectory(path, { mode: 'create', createParents: true });
        host.changed(path);
        return true;
      } catch (error: unknown) {
        failed(`add ${quoted(trimmed)}`, error);
        return false;
      }
    },

    async openJournalDay(folder, date) {
      try {
        const root = parseWorkspacePath(folder);
        let path = findJournalEntry(root, host.documentPaths(), date);
        if (!path) {
          path = journalEntryPath(root, date);
          if (!(await host.gateway.exists(path))) {
            await host.gateway.create(path, journalEntryMarkdown(date));
            host.changed(path);
          }
        }
        host.openDocument(`/${path}`);
      } catch (error: unknown) {
        failed("open that day's entry", error);
      }
    },

    async appendToJournal(text) {
      const line = text.trim().replace(/\s*\n\s*/g, ' ');
      if (!line) return false;
      try {
        const root = await setUpFolder('journal', true);
        const today = host.today();
        const entry =
          findJournalEntry(root, host.documentPaths(), today) ?? journalEntryPath(root, today);
        const stamped = `- ${localTimeOf(host.now())} ${line}\n`;
        if (await host.gateway.exists(entry)) {
          await host.gateway.rewrite(entry, async (source) =>
            source === '' || source.endsWith('\n\n') || /\n- [^\n]*\n$/.test(source)
              ? `${source}${stamped}`
              : `${source.replace(/\n*$/, '\n\n')}${stamped}`,
          );
        } else {
          await host.gateway.create(entry, `${journalEntryMarkdown(today)}${stamped}`);
        }
        host.changed(entry);
        host.report('success', "Added to today's journal entry.");
        return true;
      } catch (error: unknown) {
        failed('add that to your journal', error);
        return false;
      }
    },

    async addDescribedTask(task) {
      const title = task.title.trim();
      if (!title) return null;
      try {
        const folder = await tasksFolderForNewTask();
        const path = await createTask(host.gateway, folder, {
          title,
          ...(task.due ? { due: task.due } : {}),
          ...(task.category ? { category: task.category } : {}),
          ...(task.notes ? { body: `${task.notes.trim()}\n` } : {}),
        });
        host.changed(path);
        return path;
      } catch (error: unknown) {
        failed(`add ${quoted(title)}`, error);
        return null;
      }
    },

    async editDocument(path, change, doing) {
      try {
        const target = parseWorkspacePath(path);
        let kept = false;
        await host.gateway.rewrite(target, async (source) => {
          const next = await change(source);
          // A retried write calls this again; one version is enough.
          if (next !== source && !kept && host.keepVersion) {
            await host.keepVersion(target, source);
            kept = true;
          }
          return next;
        });
        host.changed(target);
        return { versionKept: kept };
      } catch (error: unknown) {
        failed(doing, error);
        return null;
      }
    },

    async saveNote(text, title) {
      const body = text.trim();
      if (!body) return null;
      try {
        const root = await setUpFolder('unfiled', true);
        const name = title?.trim() || noteTitleFor(body);
        const path = await freeFilePath(root, markdownFileNameForTitle(name, 'Note'));
        await host.gateway.create(path, `${body}\n`);
        host.changed(path);
        host.report('success', `Saved to ${displayFolder(root)}.`);
        return path;
      } catch (error: unknown) {
        failed('save that note', error);
        return null;
      }
    },

    async ensureUnfiled() {
      try {
        return await setUpFolder('unfiled', true);
      } catch (error: unknown) {
        failed('set up your Unfiled drawer', error);
        return null;
      }
    },

    async fileTo(path, folder) {
      const from = parseWorkspacePath(path);
      try {
        const to = await freeFilePath(folder, workspacePathBasename(from));
        await host.gateway.move(from, to);
        host.changed(from);
        host.changed(to);
        host.report(
          'success',
          `Moved ${quoted(titleOfFileName(from))} to ${displayFolder(folder)}.`,
        );
      } catch (error: unknown) {
        failed(`move ${quoted(titleOfFileName(from))}`, error);
      }
    },

    async makeTask(path) {
      const from = parseWorkspacePath(path);
      if (!/\.(?:md|markdown|mdown)$/i.test(from)) {
        host.report('error', 'Only a note can become a task. File this one in a folder instead.');
        return;
      }
      try {
        const folder = await tasksFolderForNewTask();
        const to = await freeFilePath(
          workspacePathJoin(folder.path, folder.defaultFolder),
          workspacePathBasename(from),
        );
        await host.gateway.move(from, to);
        host.changed(from);
        host.changed(to);
        host.report('success', `${quoted(titleOfFileName(to))} is now a task.`);
      } catch (error: unknown) {
        failed(`make ${quoted(titleOfFileName(from))} a task`, error);
      }
    },

    async remove(path) {
      const target = parseWorkspacePath(path);
      const name = workspacePathBasename(target);
      if (!(await host.confirmDelete(`Delete ${quoted(name)}? This cannot be undone.`))) return;
      try {
        await host.storage.remove(target, { missing: 'ignore' });
        const companion = target.replace(/\.[^./]+$/, '_files');
        if (companion !== target) {
          await host.storage.remove(parseWorkspacePath(companion), {
            recursive: true,
            missing: 'ignore',
          });
        }
        host.changed(target);
      } catch (error: unknown) {
        failed(`delete ${quoted(name)}`, error);
      }
    },
  };
}

export { setTaskProperties };
