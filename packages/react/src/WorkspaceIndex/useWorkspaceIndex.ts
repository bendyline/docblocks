/**
 * Owns the active workspace's index: one per provider instance, disposed
 * (cancelling any in-flight walk) when the workspace changes.
 *
 * The index module is loaded on demand so it stays out of the startup bundle,
 * and indexing starts once the browser is idle so it never competes with the
 * explorer's first listing.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getFileSystemProviderV2, type FileSystemProvider } from '@bendyline/docblocks/filesystem';
import { maybeGetDocBlocksHost } from '@bendyline/docblocks/host';
import type { WorkspaceIndex, WorkspaceIndexStatus } from '@bendyline/docblocks/workspace-index';

/**
 * `eager` indexes once the browser is idle; `on-demand` waits until a feature
 * needs it (quick-open, search); `off` never indexes.
 */
export type WorkspaceIndexMode = 'eager' | 'on-demand' | 'off';

export const IDLE_WORKSPACE_INDEX_STATUS: WorkspaceIndexStatus = Object.freeze({
  phase: 'idle',
  fileCount: 0,
  documentCount: 0,
  analyzedCount: 0,
  pendingCount: 0,
  watching: false,
  listed: false,
  truncated: null,
  issues: 0,
  error: null,
  generation: 0,
});

export interface WorkspaceIndexHandle {
  readonly index: WorkspaceIndex | null;
  readonly status: WorkspaceIndexStatus;
  /** Start indexing now (a feature needs it), and catch up if not watching. */
  ensure(): void;
}

type WorkspaceIndexModule = typeof import('@bendyline/docblocks/workspace-index');

let indexModule: Promise<WorkspaceIndexModule> | null = null;
function loadWorkspaceIndexModule(): Promise<WorkspaceIndexModule> {
  indexModule ??= import('@bendyline/docblocks/workspace-index');
  return indexModule;
}

const IDLE_START_TIMEOUT_MS = 3_000;

function whenIdle(callback: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(callback, { timeout: IDLE_START_TIMEOUT_MS });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(callback, 500);
  return () => clearTimeout(handle);
}

export function useWorkspaceIndex(
  provider: FileSystemProvider | null,
  workspaceId: string | null,
  mode: WorkspaceIndexMode = 'eager',
): WorkspaceIndexHandle {
  const providerV2 = provider && mode !== 'off' ? getFileSystemProviderV2(provider) : null;
  const [index, setIndex] = useState<WorkspaceIndex | null>(null);
  // `ensure()` can arrive while the module is still loading.
  const startRequestedRef = useRef(false);

  useEffect(() => {
    setIndex(null);
    startRequestedRef.current = false;
    if (!providerV2 || !workspaceId) return;
    let disposed = false;
    let created: WorkspaceIndex | null = null;
    let cancelIdle: (() => void) | null = null;
    void loadWorkspaceIndexModule()
      .then(({ createWorkspaceIndex }) => {
        if (disposed) return;
        created = createWorkspaceIndex({ workspaceId, source: providerV2 });
        setIndex(created);
        const instance = created;
        if (startRequestedRef.current) instance.start();
        else if (mode === 'eager') cancelIdle = whenIdle(() => instance.start());
      })
      .catch(() => {
        // Without the module there is simply no index; features degrade.
      });
    return () => {
      disposed = true;
      cancelIdle?.();
      created?.dispose();
    };
  }, [providerV2, workspaceId, mode]);

  // Keep a non-watching index current across focus changes and app resumes,
  // and stop provider reads entirely while the page is hidden.
  useEffect(() => {
    if (!index) return;
    const refresh = () => index.refresh();
    const onVisibilityChange = () => {
      const hidden = document.visibilityState === 'hidden';
      index.setPaused(hidden);
      if (!hidden) refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibilityChange);
    const stopResume = maybeGetDocBlocksHost()?.lifecycle?.onResume?.(refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopResume?.();
    };
  }, [index]);

  const subscribe = useCallback(
    (listener: () => void) => (index ? index.subscribe(listener) : () => undefined),
    [index],
  );
  const getStatus = useCallback(
    () => (index ? index.getStatus() : IDLE_WORKSPACE_INDEX_STATUS),
    [index],
  );
  const status = useSyncExternalStore(subscribe, getStatus, getStatus);

  const ensure = useCallback(() => {
    if (!index) {
      startRequestedRef.current = true;
      return;
    }
    index.start();
    index.refresh();
  }, [index]);

  return useMemo(() => ({ index, status, ensure }), [index, status, ensure]);
}
