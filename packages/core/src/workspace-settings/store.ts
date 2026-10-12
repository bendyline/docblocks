/**
 * Read and write `.docblocks/workspace.json` through a workspace's v2
 * provider (or any adapter with the same read/write contract). Every surface
 * shares these conflict and merge rules.
 */

import { FsError } from '../filesystem/fs-error.js';
import { decodeUtf8Text } from '../filesystem/utf8.js';
import type { FileSystemProviderV2, FileSystemVersion } from '../filesystem/v2.js';
import { parseWorkspacePath } from '../filesystem/workspace-path.js';
import {
  applyWorkspaceSettingsPatch,
  isDefaultWorkspaceSettings,
  parseWorkspaceSettingsText,
  serializeWorkspaceSettings,
  WORKSPACE_SETTINGS_PATH,
  type WorkspaceSettings,
  type WorkspaceSettingsPatch,
} from './settings.js';

/** The two operations settings persistence needs. */
export type WorkspaceSettingsIO = Pick<FileSystemProviderV2, 'readFile' | 'writeFile'>;

export type WorkspaceSettingsStatus =
  | 'unavailable'
  | 'loading'
  | 'missing'
  | 'ready'
  | 'invalid'
  | 'unsupported-version'
  | 'error';

export interface WorkspaceSettingsState {
  readonly status: WorkspaceSettingsStatus;
  /** Settings in effect; null unless the file is missing (defaults) or valid. */
  readonly settings: WorkspaceSettings | null;
  /** Version of the file that `settings` came from; null when it does not exist. */
  readonly version: FileSystemVersion | null;
  /** Why the file cannot be used or changed, for display. */
  readonly message: string | null;
}

export const UNAVAILABLE_WORKSPACE_SETTINGS: WorkspaceSettingsState = Object.freeze({
  status: 'unavailable',
  settings: null,
  version: null,
  message: 'Workspace settings need a folder workspace.',
});

export const LOADING_WORKSPACE_SETTINGS: WorkspaceSettingsState = Object.freeze({
  status: 'loading',
  settings: null,
  version: null,
  message: null,
});

const SETTINGS_PATH = parseWorkspacePath(WORKSPACE_SETTINGS_PATH);

/** Only a missing file or a valid current-version file may be written. */
export function isWorkspaceSettingsWritable(state: WorkspaceSettingsState): boolean {
  return state.status === 'missing' || state.status === 'ready';
}

export async function readWorkspaceSettings(
  provider: WorkspaceSettingsIO,
): Promise<WorkspaceSettingsState> {
  let file: Awaited<ReturnType<WorkspaceSettingsIO['readFile']>>;
  try {
    file = await provider.readFile(SETTINGS_PATH);
  } catch (error) {
    return {
      status: 'error',
      settings: null,
      version: null,
      message: `Couldn't read ${WORKSPACE_SETTINGS_PATH}: ${errorMessage(error)}`,
    };
  }
  if (!file) return { status: 'missing', settings: null, version: null, message: null };

  let text: string;
  try {
    text = decodeUtf8Text(file.data, { label: WORKSPACE_SETTINGS_PATH, path: SETTINGS_PATH });
  } catch (error) {
    return {
      status: 'invalid',
      settings: null,
      version: file.entry.version,
      message: errorMessage(error),
    };
  }
  const parsed = parseWorkspaceSettingsText(text);
  if (parsed.status === 'ok') {
    return {
      status: 'ready',
      settings: parsed.settings,
      version: file.entry.version,
      message: null,
    };
  }
  return {
    status: parsed.status,
    settings: null,
    version: file.entry.version,
    message: parsed.message,
  };
}

function isConcurrentChange(error: unknown): boolean {
  return (
    error instanceof FsError &&
    (error.code === 'conflict' || error.code === 'already-exists' || error.code === 'not-found')
  );
}

async function writeSettings(
  provider: WorkspaceSettingsIO,
  base: WorkspaceSettings | null,
  version: FileSystemVersion | null,
  patch: WorkspaceSettingsPatch,
): Promise<WorkspaceSettingsState> {
  const next = applyWorkspaceSettingsPatch(base, patch);
  // Never create `.docblocks/workspace.json` just to record defaults. A file
  // that already exists is still updated (and never deleted).
  if (version === null && isDefaultWorkspaceSettings(next)) {
    return { status: 'missing', settings: null, version: null, message: null };
  }
  const snapshot = await provider.writeFile(
    SETTINGS_PATH,
    new TextEncoder().encode(serializeWorkspaceSettings(next)),
    { mode: version ? 'replace' : 'create', createParents: true, expectedVersion: version },
  );
  return { status: 'ready', settings: next, version: snapshot.version, message: null };
}

/**
 * Apply a field-level patch on top of the file version the caller last
 * observed. When another window or a git pull changed the file meanwhile,
 * re-read it and apply the same patch once more so neither edit is lost.
 * A file that turned invalid or newer is never overwritten, and a missing file
 * is not created when the result would only hold defaults.
 */
export async function saveWorkspaceSettingsPatch(
  provider: WorkspaceSettingsIO,
  observed: WorkspaceSettingsState,
  patch: WorkspaceSettingsPatch,
): Promise<WorkspaceSettingsState> {
  if (!isWorkspaceSettingsWritable(observed)) {
    throw new Error(observed.message ?? 'These workspace settings cannot be changed.');
  }
  try {
    return await writeSettings(provider, observed.settings, observed.version, patch);
  } catch (error) {
    if (!isConcurrentChange(error)) throw error;
  }
  const fresh = await readWorkspaceSettings(provider);
  if (!isWorkspaceSettingsWritable(fresh)) {
    throw new Error(fresh.message ?? 'The workspace settings file changed and cannot be updated.');
  }
  return writeSettings(provider, fresh.settings, fresh.version, patch);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
