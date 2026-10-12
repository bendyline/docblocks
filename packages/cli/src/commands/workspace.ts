/**
 * workspace command — maintain the outputs a workspace opts into through
 * `<workspace root>/.docblocks/workspace.json`.
 *
 * `workspace refresh` runs the same filesystem-agnostic catalog refresh the
 * editor shell runs (`@bendyline/docblocks/workspace-settings`) over a Node
 * adapter, so CI and scripts produce byte-identical `index.html` /
 * `catalog.json` outputs. Only enabled outputs are written, only files that
 * carry the DocBlocks catalog marker are replaced, and unchanged bytes are
 * never rewritten.
 */

import { Command } from 'commander';
import { FsError } from '@bendyline/docblocks/filesystem';
import {
  WORKSPACE_SETTINGS_PATH,
  refreshWorkspaceOutputs,
  resolveCatalogOutputs,
  type WorkspaceOutputLimits,
  type WorkspaceOutputResult,
  type WorkspaceOutputsRenderer,
  type WorkspaceOutputsResult,
} from '@bendyline/docblocks/workspace-settings';
import { htmlToMarkdownDocSync, markdownDocToPlainHtml } from '@bendyline/squisq-formats/html';
import { getAvailableThemeIds } from '../internal/theme.js';
import { createNodeWorkspaceIO } from '../internal/workspace-io.js';
import {
  describeWorkspaceSettingsProblem,
  readWorkspaceSettings,
} from '../internal/workspace-settings.js';

export interface WorkspaceRefreshOptions {
  /** Workspace root; defaults to the current directory. */
  readonly dir?: string;
  /** Rewrite the catalog page even when its inputs digest is unchanged. */
  readonly force?: boolean;
  /** Compute every output and report what would change; write nothing. */
  readonly dryRun?: boolean;
  readonly signal?: AbortSignal;
  /** Receives non-fatal warnings; defaults to stderr. */
  readonly onWarning?: (message: string) => void;
  /** Programmatic budget overrides for the catalog walk. */
  readonly limits?: Partial<WorkspaceOutputLimits>;
}

export interface WorkspaceRefreshResult {
  /** Physical workspace root. */
  readonly root: string;
  /**
   * `missing` when the workspace has no settings file, `disabled` when its
   * settings enable no output, otherwise `refreshed`.
   */
  readonly status: 'missing' | 'disabled' | 'refreshed';
  readonly documentCount: number;
  readonly outputs: readonly WorkspaceOutputResult[];
  readonly dryRun: boolean;
}

/**
 * Regenerate the catalog outputs a workspace enables. Throws when the
 * settings file is invalid or from a newer DocBlocks, when the walk exceeds
 * its budget, and on storage failures. A blocked output (a hand-written file
 * at the configured path) is reported in `outputs`, not thrown.
 */
export async function runWorkspaceRefresh(
  options: WorkspaceRefreshOptions = {},
): Promise<WorkspaceRefreshResult> {
  const io = await createNodeWorkspaceIO(options.dir ?? '.');
  const dryRun = options.dryRun === true;
  const settingsRead = await readWorkspaceSettings(io);
  if (settingsRead.status === 'missing') {
    return { root: io.root, status: 'missing', documentCount: 0, outputs: [], dryRun };
  }
  if (settingsRead.status !== 'ok') {
    throw new Error(describeWorkspaceSettingsProblem(settingsRead.message));
  }
  const settings = settingsRead.settings;
  const resolved = resolveCatalogOutputs(settings);
  if (!resolved) {
    return { root: io.root, status: 'disabled', documentCount: 0, outputs: [], dryRun };
  }

  const warn = options.onWarning ?? ((message: string) => console.warn(message));
  const catalogThemeId = resolved.html?.themeId;
  if (catalogThemeId && !(await getAvailableThemeIds()).includes(catalogThemeId)) {
    warn(
      `Catalog theme "${catalogThemeId}" from ${WORKSPACE_SETTINGS_PATH} is not a known theme; the page renders with the standard theme.`,
    );
  }

  const refresh = (): Promise<WorkspaceOutputsResult> =>
    refreshWorkspaceOutputs(io, settings, renderer, {
      signal: options.signal,
      force: options.force === true,
      dryRun,
      limits: options.limits,
    });
  let result: WorkspaceOutputsResult;
  try {
    result = await refresh();
  } catch (error: unknown) {
    // A concurrent writer won a conditional write; one re-run observes it.
    if (!(error instanceof FsError) || error.code !== 'conflict') throw error;
    result = await refresh();
  }
  return {
    root: io.root,
    status: 'refreshed',
    documentCount: result.documentCount,
    outputs: result.outputs,
    dryRun,
  };
}

/** Squisq's script-free, themed plain HTML page renderer and HTML importer. */
const renderer: WorkspaceOutputsRenderer = {
  renderCatalogHtml: (document, { title, themeId }) =>
    markdownDocToPlainHtml(document, { title, themeId }),
  importHtml: (html) => htmlToMarkdownDocSync(html),
};

/** One human-readable status line per output, as printed by the command. */
export function describeWorkspaceOutput(output: WorkspaceOutputResult): string {
  const status = output.status === 'would-write' ? 'would write' : output.status;
  return output.message
    ? `${status} ${output.path}: ${output.message}`
    : `${status} ${output.path}`;
}

const refreshCommand = new Command('refresh')
  .description(`Regenerate the catalog outputs enabled in <dir>/${WORKSPACE_SETTINGS_PATH}`)
  .argument('[dir]', 'workspace root', '.')
  .option('--force', 'rewrite the catalog page even when its inputs are unchanged')
  .option('--dry-run', 'report what would change without writing anything')
  .action(async (dir: string, opts: { force?: boolean; dryRun?: boolean }) => {
    try {
      const result = await runWorkspaceRefresh({ dir, force: opts.force, dryRun: opts.dryRun });
      if (result.status === 'missing') {
        console.error(
          `No workspace settings found at ${WORKSPACE_SETTINGS_PATH} in ${result.root}; no outputs are enabled.`,
        );
        return;
      }
      if (result.status === 'disabled') {
        console.error(`${WORKSPACE_SETTINGS_PATH} enables no catalog outputs; nothing to refresh.`);
        return;
      }
      for (const output of result.outputs) console.error(describeWorkspaceOutput(output));
      console.error(
        `${result.dryRun ? 'Dry run: ' : ''}${result.documentCount} document(s) cataloged in ${result.root}.`,
      );
      if (result.outputs.some((output) => output.status === 'blocked')) process.exitCode = 1;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exitCode = 1;
    }
  });

export const workspaceCommand = new Command('workspace')
  .description(`Maintain workspace outputs configured in ${WORKSPACE_SETTINGS_PATH}`)
  .addCommand(refreshCommand);
