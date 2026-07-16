/**
 * useGitStatus — subscribes to the host's owner-scoped repository stream.
 *
 * Dedupes identical payloads so a permanently-dirty working tree (normal
 * under the manual-commit model) doesn't repaint the tree on every push
 * from the main process.
 *
 * Every asynchronous path is generation-guarded. Switching workspaces
 * while a `scheduleRefresh` debounce is pending, or while a `refresh()`
 * request is in flight, must not paint the previous repository's branch,
 * badges, and dirty count onto the new one.
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
  /**
   * Bumped every time the subscribed repository changes. An in-flight
   * `status()` that resolves after the switch belongs to the old repo and
   * is dropped instead of being painted onto the new workspace.
   */
  const generationRef = useRef(0);

  const apply = useCallback((next: GitStatus) => {
    const key = statusKey(next);
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    setStatus(next);
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    // A refresh debounced against the previous repository must not land on
    // the new one: the timer outlives the effect that scheduled it.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
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
    const generation = generationRef.current;
    void gitApi.status(repositoryId).then(
      (result) => {
        if (generation !== generationRef.current) return;
        if (result.ok) apply(result.value);
      },
      // A rejected status (IPC torn down mid-switch) is not actionable
      // here — the subscription stays the source of truth. Swallow it
      // rather than leave an unhandled rejection.
      () => undefined,
    );
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
