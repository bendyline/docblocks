/**
 * Read `<workspace root>/.docblocks/workspace.json` for CLI commands.
 *
 * The file is a persisted wire payload: it is decoded as strict UTF-8 and
 * accepted only through core's exact-shape parser. Absence is the ordinary
 * case (most folders have no settings) and is reported as `missing`; invalid
 * or newer-version content is reported with the parser's message so callers
 * can decide whether to fail (`workspace refresh`) or warn (`build`/`serve`).
 * Storage failures other than absence propagate as typed `FsError`s.
 */

import { decodeUtf8Text, parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import {
  WORKSPACE_SETTINGS_LIMITS,
  WORKSPACE_SETTINGS_PATH,
  parseWorkspaceSettingsText,
  resolveWorkspaceDefaultThemeId,
  type WorkspaceOutputsIO,
  type WorkspaceSettings,
} from '@bendyline/docblocks/workspace-settings';
import { getAvailableThemeIds } from './theme.js';
import { createNodeWorkspaceIO } from './workspace-io.js';

export type WorkspaceSettingsReadResult =
  | { readonly status: 'missing' }
  | { readonly status: 'ok'; readonly settings: WorkspaceSettings }
  | { readonly status: 'invalid' | 'unsupported-version'; readonly message: string };

/** A UTF-8 byte-order mark is tolerated on top of the decoded-text budget. */
const MAX_SETTINGS_FILE_BYTES = WORKSPACE_SETTINGS_LIMITS.maxFileBytes + 3;

export async function readWorkspaceSettings(
  io: Pick<WorkspaceOutputsIO, 'stat' | 'readFile'>,
): Promise<WorkspaceSettingsReadResult> {
  const settingsPath = parseWorkspacePath(WORKSPACE_SETTINGS_PATH);
  const info = await io.stat(settingsPath);
  if (!info) return { status: 'missing' };
  if (info.kind !== 'file') {
    return { status: 'invalid', message: `${WORKSPACE_SETTINGS_PATH} is a folder, not a file.` };
  }
  if (info.size > MAX_SETTINGS_FILE_BYTES) return tooLarge();
  const read = await io.readFile(settingsPath);
  if (!read) return { status: 'missing' };
  if (read.data.byteLength > MAX_SETTINGS_FILE_BYTES) return tooLarge();
  let text: string;
  try {
    text = decodeUtf8Text(read.data, {
      label: 'Workspace settings',
      path: WORKSPACE_SETTINGS_PATH,
    });
  } catch (error: unknown) {
    return {
      status: 'invalid',
      message: error instanceof Error ? error.message : `${WORKSPACE_SETTINGS_PATH} is not UTF-8.`,
    };
  }
  return parseWorkspaceSettingsText(text);
}

/** Parser message prefixed with the settings path when it does not already name it. */
export function describeWorkspaceSettingsProblem(message: string): string {
  return message.includes(WORKSPACE_SETTINGS_PATH)
    ? message
    : `${WORKSPACE_SETTINGS_PATH}: ${message}`;
}

function tooLarge(): WorkspaceSettingsReadResult {
  return {
    status: 'invalid',
    message: `${WORKSPACE_SETTINGS_PATH} is larger than ${WORKSPACE_SETTINGS_LIMITS.maxFileBytes / 1024} KiB.`,
  };
}

export interface WorkspaceThemeFallback {
  /**
   * The workspace default theme to use for documents that name none, or
   * undefined. Re-reads the settings file on every call so a long-running
   * preview follows edits; a repeated problem is reported only once.
   */
  resolve(): Promise<string | undefined>;
}

/**
 * Resolve `documents.defaultTheme` for `build` and `serve`. Invalid settings
 * and unknown theme ids warn and fall back to Squisq's own resolution rather
 * than failing the command.
 */
export async function createWorkspaceThemeFallback(
  rootDir: string,
  warn: (message: string) => void,
): Promise<WorkspaceThemeFallback> {
  const io = await createNodeWorkspaceIO(rootDir);
  let lastWarning: string | null = null;
  const report = (message: string | null): void => {
    if (message !== null && message !== lastWarning) warn(message);
    lastWarning = message;
  };
  return {
    async resolve() {
      const result = await readWorkspaceSettings(io);
      if (result.status === 'missing') {
        report(null);
        return undefined;
      }
      if (result.status !== 'ok') {
        report(`Ignoring workspace settings. ${describeWorkspaceSettingsProblem(result.message)}`);
        return undefined;
      }
      const themeId = resolveWorkspaceDefaultThemeId(result.settings);
      if (themeId && !(await getAvailableThemeIds()).includes(themeId)) {
        report(
          `Ignoring workspace default theme "${themeId}" from ${WORKSPACE_SETTINGS_PATH}: it is not a known theme.`,
        );
        return undefined;
      }
      report(null);
      return themeId;
    },
  };
}
