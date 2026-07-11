/**
 * useGitStatus — subscribes to the host's owner-scoped repository stream.
 *
 * Dedupes identical payloads so a permanently-dirty working tree (normal
 * under the manual-commit model) doesn't repaint the tree on every push
 * from the main process.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocBlocksHostGitAPI, GitStatus } from '@bendyline/docblocks/host';

const SCHEDULE_REFRESH_MS = 1500;

function statusKey(status: GitStatus): string {
  return JSON.stringify(status);
}

export interface UseGitStatusResult {
  status: GitStatus | null;
  /** Fetch a fresh status immediately (after a renderer-initiated git op). */
  refresh: () => void;
  /** Trailing-debounced refresh (after autosave writes). */
  scheduleRefresh: () => void;
}

export function useGitStatus(
  gitApi: DocBlocksHostGitAPI | null,
  repositoryId: string | null,
  enabled: boolean,
): UseGitStatusResult {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const lastKeyRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apply = useCallback((next: GitStatus) => {
    const key = statusKey(next);
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    setStatus(next);
  }, []);

  useEffect(() => {
    lastKeyRef.current = null;
    setStatus(null);
    if (!gitApi || !repositoryId || !enabled) return;
    let cancelled = false;
    const unsubscribe = gitApi.onStatusChanged(repositoryId, (next) => {
      if (!cancelled) apply(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [gitApi, repositoryId, enabled, apply]);

  const refresh = useCallback(() => {
    if (!gitApi || !repositoryId || !enabled) return;
    void gitApi.status(repositoryId).then((result) => {
      if (result.ok) apply(result.value);
    });
  }, [gitApi, repositoryId, enabled, apply]);

  const scheduleRefresh = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      refresh();
    }, SCHEDULE_REFRESH_MS);
  }, [refresh]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { status, refresh, scheduleRefresh };
}
