/**
 * Versioning preferences — global default + per-workspace resolution.
 *
 * The global preference controls whether DocBlocks writes version
 * snapshots (under `<basename>_files/.versions/`) when editing. The
 * default is `'browser-only'` so local-folder workspaces stay clean by
 * default and only IndexedDB workspaces accumulate version history.
 *
 * Each workspace can override the global default with its own setting
 * stored on the WorkspaceDescriptor. `'inherit'` (or absent) defers to
 * the global preference; `'on'` / `'off'` force the behavior regardless.
 */

import type { WorkspaceDescriptor } from '@bendyline/docblocks/workspace';

export type VersioningPreference = 'on' | 'browser-only' | 'off';

const STORAGE_KEY = 'docblocks:versioningPreference';
const DEFAULT_PREFERENCE: VersioningPreference = 'browser-only';

export function loadVersioningPreference(): VersioningPreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'on' || raw === 'browser-only' || raw === 'off') return raw;
  } catch {
    // ignore
  }
  return DEFAULT_PREFERENCE;
}

export function saveVersioningPreference(value: VersioningPreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // ignore quota errors
  }
}

/** Whether a workspace type is "local" (writes to a real folder on disk). */
export function isLocalWorkspaceType(type: WorkspaceDescriptor['type']): boolean {
  return type === 'native' || type === 'electron-native';
}

/**
 * Compute the effective versioning state for a workspace, honoring the
 * per-workspace override first and falling back to the global preference.
 *
 * Returns `false` whenever no workspace is provided so callers can use
 * this directly during initial render before a workspace loads.
 */
export function resolveVersioningEnabled(
  workspace: WorkspaceDescriptor | null,
  globalPref: VersioningPreference,
): boolean {
  if (!workspace) return false;

  const override = workspace.versioningOverride;
  if (override === 'on') return true;
  if (override === 'off') return false;

  switch (globalPref) {
    case 'on':
      return true;
    case 'off':
      return false;
    case 'browser-only':
      return !isLocalWorkspaceType(workspace.type);
  }
}
