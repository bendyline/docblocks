/**
 * The active workspace's `.docblocks/workspace.json`, kept current.
 *
 * The file can change outside this window — a hand edit, a git pull, another
 * window — and only some providers can watch (the desktop watcher ignores
 * dot-folders; IndexedDB and File System Access cannot watch at all). So the
 * hook re-reads on activation, on window focus, on host resume, on provider
 * watch events for the file, and whenever `refresh()` is called (e.g. after a
 * git pull). Re-reads that observe the same version do not re-render.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { maybeGetDocBlocksHost } from '@bendyline/docblocks/host';
import { getFileSystemProviderV2, type FileSystemProvider } from '@bendyline/docblocks/filesystem';
import {
  isWorkspaceSettingsPath,
  LOADING_WORKSPACE_SETTINGS,
  readWorkspaceSettings,
  saveWorkspaceSettingsPatch,
  UNAVAILABLE_WORKSPACE_SETTINGS,
  type WorkspaceSettingsPatch,
  type WorkspaceSettingsState,
} from '@bendyline/docblocks/workspace-settings';

export interface UseWorkspaceSettingsResult extends WorkspaceSettingsState {
  /** Re-read the file now. */
  refresh: () => void;
  /** Apply a patch on top of the observed file (merging one concurrent change). */
  save: (patch: WorkspaceSettingsPatch) => Promise<WorkspaceSettingsState>;
}

function sameState(left: WorkspaceSettingsState, right: WorkspaceSettingsState): boolean {
  return (
    left.status === right.status && left.version === right.version && left.message === right.message
  );
}

/**
 * @param provider The active workspace's provider, or null.
 * @param enabled  False for transient workspaces (single files, DBK bundles):
 *                 they have no folder for settings to live in.
 */
export function useWorkspaceSettings(
  provider: FileSystemProvider | null,
  enabled: boolean,
): UseWorkspaceSettingsResult {
  const providerV2 = provider && enabled ? getFileSystemProviderV2(provider) : null;
  const [state, setState] = useState<WorkspaceSettingsState>(
    providerV2 ? LOADING_WORKSPACE_SETTINGS : UNAVAILABLE_WORKSPACE_SETTINGS,
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const generationRef = useRef(0);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  // Reset synchronously when the provider changes so a previous workspace's
  // settings never apply to the next one, even for a single render.
  const providerRef = useRef(providerV2);
  if (providerRef.current !== providerV2) {
    providerRef.current = providerV2;
    generationRef.current += 1;
    const reset = providerV2 ? LOADING_WORKSPACE_SETTINGS : UNAVAILABLE_WORKSPACE_SETTINGS;
    stateRef.current = reset;
    setState(reset);
  }

  useEffect(() => {
    if (!providerV2) return;
    const generation = generationRef.current;
    let cancelled = false;
    void readWorkspaceSettings(providerV2).then((next) => {
      if (cancelled || generation !== generationRef.current) return;
      if (!sameState(stateRef.current, next)) {
        stateRef.current = next;
        setState(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [providerV2, refreshKey]);

  useEffect(() => {
    if (!providerV2) return;
    window.addEventListener('focus', refresh);
    const stopResume = maybeGetDocBlocksHost()?.lifecycle?.onResume?.(refresh);
    const subscription = providerV2.capabilities.watch
      ? providerV2.watch(
          (event) => {
            if (
              isWorkspaceSettingsPath(event.path) ||
              (event.destinationPath !== null && isWorkspaceSettingsPath(event.destinationPath)) ||
              event.type === 'overflow'
            ) {
              refresh();
            }
          },
          { onError: () => undefined },
        )
      : null;
    void subscription?.ready.catch(() => undefined);
    return () => {
      window.removeEventListener('focus', refresh);
      stopResume?.();
      void subscription?.dispose();
    };
  }, [providerV2, refresh]);

  const save = useCallback(
    async (patch: WorkspaceSettingsPatch) => {
      if (!providerV2) throw new Error(UNAVAILABLE_WORKSPACE_SETTINGS.message ?? undefined);
      const generation = generationRef.current;
      const next = await saveWorkspaceSettingsPatch(providerV2, stateRef.current, patch);
      if (generation === generationRef.current) {
        stateRef.current = next;
        setState(next);
      }
      return next;
    },
    [providerV2],
  );

  return { ...state, refresh, save };
}
