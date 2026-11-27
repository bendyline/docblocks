/**
 * Read and write `<folder>/.docblocks/folder.json` through a workspace's v2
 * provider (or any adapter with the same contract).
 */

import { FsError } from '../filesystem/fs-error.js';
import { decodeUtf8Text } from '../filesystem/utf8.js';
import type { FileSystemProviderV2, FileSystemVersion } from '../filesystem/v2.js';
import type { WorkspacePath } from '../filesystem/workspace-path.js';
import {
  FOLDER_SETTINGS_LIMITS,
  folderSettingsPath,
  parseFolderSettingsText,
  serializeFolderSettings,
  type FolderSettings,
} from './folder-settings.js';

export type FolderSettingsReader = Pick<FileSystemProviderV2, 'readFile'>;
export type FolderSettingsIO = Pick<FileSystemProviderV2, 'readFile' | 'writeFile' | 'remove'>;

export type FolderSettingsStatus =
  | 'missing'
  | 'ready'
  | 'invalid'
  | 'unsupported-version'
  | 'unsupported-kind'
  | 'error';

export interface FolderSettingsState {
  readonly status: FolderSettingsStatus;
  /** Null unless the file is valid and of a kind this version knows. */
  readonly settings: FolderSettings | null;
  /** Version of the file `settings` came from; null when there is no file. */
  readonly version: FileSystemVersion | null;
  /** Why the file cannot be used, for display. */
  readonly message: string | null;
}

const MISSING: FolderSettingsState = Object.freeze({
  status: 'missing',
  settings: null,
  version: null,
  message: null,
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What `folder` says it is. A folder with no settings file is an ordinary one (`missing`). */
export async function readFolderSettings(
  provider: FolderSettingsReader,
  folder: WorkspacePath,
): Promise<FolderSettingsState> {
  const path = folderSettingsPath(folder);
  let file: Awaited<ReturnType<FolderSettingsReader['readFile']>>;
  try {
    file = await provider.readFile(path);
  } catch (error: unknown) {
    if (error instanceof FsError && error.code === 'not-found') return MISSING;
    return {
      status: 'error',
      settings: null,
      version: null,
      message: `Couldn't read ${path}: ${errorMessage(error)}`,
    };
  }
  if (!file) return MISSING;
  const version = file.entry.version;
  if (file.data.byteLength > FOLDER_SETTINGS_LIMITS.maxFileBytes) {
    return {
      status: 'invalid',
      settings: null,
      version,
      message: 'The folder settings file is too large.',
    };
  }
  let text: string;
  try {
    text = decodeUtf8Text(file.data, { label: path, path });
  } catch (error: unknown) {
    return { status: 'invalid', settings: null, version, message: errorMessage(error) };
  }
  const parsed = parseFolderSettingsText(text);
  return parsed.status === 'ok'
    ? { status: 'ready', settings: parsed.settings, version, message: null }
    : { status: parsed.status, settings: null, version, message: parsed.message };
}

/**
 * Write a folder's settings over the version last observed. A file that
 * changed meanwhile, or one that is invalid or newer than this app, is never
 * overwritten: the write fails with a conflict for the caller to re-read.
 */
export async function writeFolderSettings(
  provider: FolderSettingsIO,
  folder: WorkspacePath,
  observed: FolderSettingsState,
  settings: FolderSettings,
): Promise<FolderSettingsState> {
  if (observed.status !== 'missing' && observed.status !== 'ready') {
    throw new Error(observed.message ?? 'These folder settings cannot be changed.');
  }
  const snapshot = await provider.writeFile(
    folderSettingsPath(folder),
    new TextEncoder().encode(serializeFolderSettings(settings)),
    {
      mode: observed.version ? 'replace' : 'create',
      createParents: true,
      expectedVersion: observed.version,
    },
  );
  return { status: 'ready', settings, version: snapshot.version, message: null };
}

/**
 * Make `folder` an ordinary folder again by removing its settings file. Only
 * that one file is removed; nothing else in `.docblocks/` is touched.
 */
export async function removeFolderSettings(
  provider: FolderSettingsIO,
  folder: WorkspacePath,
  observed: FolderSettingsState,
): Promise<void> {
  if (observed.version === null) return;
  await provider.remove(folderSettingsPath(folder), {
    missing: 'ignore',
    expectedVersion: observed.version,
  });
}
