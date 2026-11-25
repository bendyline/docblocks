/**
 * What a folder is for, recorded in `<folder>/.docblocks/folder.json`.
 *
 * The file sits inside the folder it describes, so the folder stays a tasks
 * folder when it is moved, zipped, synced to another device, or opened as a
 * workspace of its own. Deleting the file turns it back into an ordinary
 * folder.
 *
 * It is a persisted payload other tools and newer DocBlocks versions can
 * write: it enters as `unknown`, only the exact v1 shape is accepted, and a
 * newer version or an unknown kind is reported as unsupported, leaving the
 * folder to behave as an ordinary one rather than half-applying it.
 */

import { WORKSPACE_METADATA_DIRECTORY_NAME } from '../filesystem/workspace-entry-rules.js';
import {
  WORKSPACE_ROOT,
  parseWorkspacePath,
  workspacePathJoin,
  type WorkspacePath,
} from '../filesystem/workspace-path.js';

export { WORKSPACE_METADATA_DIRECTORY_NAME };
export const FOLDER_SETTINGS_FILE_NAME = 'folder.json';
export const FOLDER_SETTINGS_VERSION = 1;

export const FOLDER_KINDS = ['tasks', 'journal', 'unfiled', 'chats'] as const;
export type FolderKind = (typeof FOLDER_KINDS)[number];

export const DEFAULT_TASKS_FOLDER_NAME = 'Tasks';
export const DEFAULT_JOURNAL_FOLDER_NAME = 'Journal';
export const DEFAULT_UNFILED_FOLDER_NAME = 'Unfiled';
export const DEFAULT_CHATS_FOLDER_NAME = 'Chats';
/** The bucket new tasks go to, and reopened ones return to. */
export const DEFAULT_TASKS_OPEN_FOLDER = 'Active';
/** The bucket whose tasks are done. */
export const DEFAULT_TASKS_DONE_FOLDER = 'Done';

export const FOLDER_SETTINGS_LIMITS = {
  maxFileBytes: 16 * 1024,
  maxSchemaCharacters: 2048,
  maxFolderNameCharacters: 255,
  maxDoneFolders: 16,
} as const;

export interface TasksFolderSettings {
  /** Buckets (top-level subfolder names) whose tasks are done. Default: `Done`. */
  readonly done?: readonly string[];
  /** The bucket new tasks go to. Default: `Active`. */
  readonly default?: string;
}

export interface FolderSettings {
  readonly $schema?: string;
  readonly version: typeof FOLDER_SETTINGS_VERSION;
  readonly kind: FolderKind;
  /** Only with `kind: 'tasks'`. */
  readonly tasks?: TasksFolderSettings;
}

export type FolderSettingsParseResult =
  | { readonly status: 'ok'; readonly settings: FolderSettings }
  | {
      readonly status: 'invalid' | 'unsupported-version' | 'unsupported-kind';
      readonly message: string;
    };

class FolderSettingsShapeError extends Error {
  public constructor(
    message: string,
    public readonly status: 'invalid' | 'unsupported-version' | 'unsupported-kind' = 'invalid',
  ) {
    super(message);
  }
}

function fail(message: string): never {
  throw new FolderSettingsShapeError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object.`);
  const unknownKey = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknownKey !== undefined) fail(`${label} has an unknown field "${unknownKey}".`);
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Why `name` cannot be a bucket: buckets are single folder names directly
 * inside the tasks folder. Null when it can.
 */
export function checkBucketName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'A folder name cannot be empty.';
  if (name !== name.trim()) return 'A folder name cannot start or end with a space.';
  if (name.length > FOLDER_SETTINGS_LIMITS.maxFolderNameCharacters) {
    return 'That folder name is too long.';
  }
  if (/[\\/]/.test(name)) return 'A folder name cannot contain a slash.';
  if (name.startsWith('.')) return 'A folder name cannot start with a dot.';
  if (hasControlCharacter(name)) return 'A folder name cannot contain control characters.';
  if (name === '.' || name === '..') return 'That is not a folder name.';
  return null;
}

function bucketName(value: unknown, label: string): string {
  const problem = checkBucketName(value);
  if (problem) fail(`${label}: ${problem}`);
  return value as string;
}

/** Bucket names are compared the way a case-insensitive disk would. */
export function sameBucketName(left: string, right: string): boolean {
  return left.normalize('NFC').toLowerCase() === right.normalize('NFC').toLowerCase();
}

function parseTasks(value: unknown): TasksFolderSettings | undefined {
  if (value === undefined) return undefined;
  const record = exactRecord(value, 'tasks', ['done', 'default']);
  let done: string[] | undefined;
  if (record.done !== undefined) {
    if (!Array.isArray(record.done)) fail('tasks.done must be a list of folder names.');
    if (record.done.length === 0) fail('tasks.done must name at least one folder.');
    if (record.done.length > FOLDER_SETTINGS_LIMITS.maxDoneFolders) {
      fail(`tasks.done can name at most ${FOLDER_SETTINGS_LIMITS.maxDoneFolders} folders.`);
    }
    done = [];
    for (const entry of record.done) {
      const name = bucketName(entry, 'tasks.done');
      if (done.some((existing) => sameBucketName(existing, name))) {
        fail(`tasks.done names "${name}" twice.`);
      }
      done.push(name);
    }
  }
  const fallback =
    record.default === undefined ? undefined : bucketName(record.default, 'tasks.default');
  if (fallback !== undefined) {
    const doneNames = done ?? [DEFAULT_TASKS_DONE_FOLDER];
    if (doneNames.some((name) => sameBucketName(name, fallback))) {
      fail('tasks.default cannot be a folder that means done.');
    }
  }
  if (done === undefined && fallback === undefined) return undefined;
  return {
    ...(done ? { done } : {}),
    ...(fallback !== undefined ? { default: fallback } : {}),
  };
}

/** The settings in `value`, or a thrown shape error. Use `parseFolderSettingsText` for files. */
export function parseFolderSettings(value: unknown): FolderSettings {
  if (!isRecord(value)) fail('The folder settings must be a JSON object.');
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1) {
    fail('version must be a whole number, 1 or more.');
  }
  if (value.version > FOLDER_SETTINGS_VERSION) {
    throw new FolderSettingsShapeError(
      'This folder was set up by a newer version of DocBlocks.',
      'unsupported-version',
    );
  }
  if (typeof value.kind !== 'string' || !value.kind) fail('kind must say what the folder is.');
  if (!(FOLDER_KINDS as readonly string[]).includes(value.kind)) {
    throw new FolderSettingsShapeError(
      `This version of DocBlocks does not know the folder kind "${value.kind.slice(0, 64)}".`,
      'unsupported-kind',
    );
  }
  const record = exactRecord(value, 'The folder settings', ['$schema', 'version', 'kind', 'tasks']);
  const kind = record.kind as FolderKind;
  if (
    record.$schema !== undefined &&
    (typeof record.$schema !== 'string' ||
      record.$schema.length > FOLDER_SETTINGS_LIMITS.maxSchemaCharacters)
  ) {
    fail('$schema must be a short text value.');
  }
  if (record.tasks !== undefined && kind !== 'tasks') {
    fail('tasks settings belong only to a tasks folder.');
  }
  const tasks = parseTasks(record.tasks);
  return {
    ...(typeof record.$schema === 'string' ? { $schema: record.$schema } : {}),
    version: FOLDER_SETTINGS_VERSION,
    kind,
    ...(tasks ? { tasks } : {}),
  };
}

export function parseFolderSettingsText(text: string): FolderSettingsParseResult {
  if (text.length > FOLDER_SETTINGS_LIMITS.maxFileBytes) {
    return { status: 'invalid', message: 'The folder settings file is too large.' };
  }
  let value: unknown;
  try {
    // A byte-order mark is not part of the JSON.
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { status: 'invalid', message: 'The folder settings file is not valid JSON.' };
  }
  try {
    return { status: 'ok', settings: parseFolderSettings(value) };
  } catch (error: unknown) {
    if (error instanceof FolderSettingsShapeError) {
      return { status: error.status, message: error.message };
    }
    throw error;
  }
}

/** The file's text: stable key order, two-space indent, trailing newline. */
export function serializeFolderSettings(settings: FolderSettings): string {
  const checked = parseFolderSettings(settings);
  const ordered = {
    ...(checked.$schema !== undefined ? { $schema: checked.$schema } : {}),
    version: checked.version,
    kind: checked.kind,
    ...(checked.tasks
      ? {
          tasks: {
            ...(checked.tasks.done ? { done: [...checked.tasks.done] } : {}),
            ...(checked.tasks.default !== undefined ? { default: checked.tasks.default } : {}),
          },
        }
      : {}),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Fresh settings for a folder of `kind`. Defaults are left out of the file. */
export function defaultFolderSettings(kind: FolderKind): FolderSettings {
  return { version: FOLDER_SETTINGS_VERSION, kind };
}

/** `<folder>/.docblocks`; the workspace's own metadata folder for the root. */
export function folderMetadataPath(folder: WorkspacePath): WorkspacePath {
  return folder === WORKSPACE_ROOT
    ? parseWorkspacePath(WORKSPACE_METADATA_DIRECTORY_NAME)
    : workspacePathJoin(folder, WORKSPACE_METADATA_DIRECTORY_NAME);
}

/** `<folder>/.docblocks/folder.json`. */
export function folderSettingsPath(folder: WorkspacePath): WorkspacePath {
  return workspacePathJoin(folderMetadataPath(folder), FOLDER_SETTINGS_FILE_NAME);
}

/**
 * The folder a settings path describes, or null when `path` is not a folder
 * settings file.
 */
export function folderOfSettingsPath(path: string): WorkspacePath | null {
  const suffix = `${WORKSPACE_METADATA_DIRECTORY_NAME}/${FOLDER_SETTINGS_FILE_NAME}`;
  if (path === suffix) return WORKSPACE_ROOT;
  if (!path.endsWith(`/${suffix}`)) return null;
  try {
    return parseWorkspacePath(path.slice(0, path.length - suffix.length - 1));
  } catch {
    return null;
  }
}
