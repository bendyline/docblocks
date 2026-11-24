/**
 * Keeps a digest of each workspace on this device, so Home and Tasks can show
 * what is due in workspaces that are not open.
 *
 * - The open workspace's digest is projected from its index as it changes
 *   and saved when it says something new.
 * - Other workspaces show their last saved digest, marked with when it was
 *   made, and are refreshed one at a time in the background while a page that
 *   shows them is open: a short-lived index over storage opened without any
 *   prompt, given a time budget, then disposed. A workspace that cannot be
 *   opened silently (a browser folder whose permission lapsed) keeps its last
 *   digest until it is next opened.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getFileSystemProviderV2, type FileSystemProvider } from '@bendyline/docblocks/filesystem';
import { localDateOf } from '@bendyline/docblocks/properties';
import { readWorkspaceDigests, writeWorkspaceDigest } from '@bendyline/docblocks/workspace';
import { kindFoldersFromMarkers, taskItemsFromDocuments } from '../Tasks/task-model.js';
import {
  parseHomeDigest,
  projectHomeDigest,
  sameHomeDigest,
  type HomeDigest,
} from './home-digest.js';

export interface DigestWorkspace {
  readonly id: string;
  readonly name: string;
}

export interface WorkspaceSummary {
  readonly workspaceId: string;
  readonly name: string;
  readonly digest: HomeDigest | null;
  /** Being read in the background now. */
  readonly refreshing: boolean;
}

export interface HomeDigestSources {
  /** The workspaces this surface shows, by id and name. */
  listWorkspaces(): Promise<readonly DigestWorkspace[]>;
  /**
   * Storage for a workspace that is not open, opened without asking the
   * person anything; null when that is not possible. The caller releases it.
   */
  openSilently(workspaceId: string): Promise<{
    readonly provider: FileSystemProvider;
    release(): Promise<void>;
  } | null>;
}

/** How long one background read may take before it is given up. */
const REFRESH_BUDGET_MS = 30_000;
/** A digest younger than this is not read again in the background. */
const FRESH_MS = 10 * 60_000;
const SAVE_DEBOUNCE_MS = 1_500;

/** Read a workspace once and digest it. Null when it took too long or failed. */
export async function digestWorkspaceOnce(
  workspaceId: string,
  provider: FileSystemProvider,
  options: {
    readonly budgetMs?: number;
    readonly signal?: AbortSignal;
    readonly now?: () => Date;
  } = {},
): Promise<HomeDigest | null> {
  const v2 = getFileSystemProviderV2(provider);
  if (!v2) return null;
  // Loaded on demand, as the open workspace's index is: it stays out of every launch.
  const { createWorkspaceIndex } = await import('@bendyline/docblocks/workspace-index');
  // No watch: this index lives for one read and must not start a watcher.
  const index = createWorkspaceIndex({
    workspaceId,
    source: {
      stat: (path) => v2.stat(path),
      readFile: (path) => v2.readFile(path),
      readDirectory: (path) => v2.readDirectory(path),
      ...(v2.enumerate ? { enumerate: v2.enumerate.bind(v2) } : {}),
      capabilities: { watch: false },
    },
  });
  try {
    index.start();
    const settled = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), options.budgetMs ?? REFRESH_BUDGET_MS);
      const check = () => {
        const status = index.getStatus();
        if (status.phase === 'ready') finish(true);
        else if (status.phase === 'error' || status.phase === 'disposed') finish(false);
      };
      const unsubscribe = index.subscribe(check);
      const onAbort = () => finish(false);
      options.signal?.addEventListener('abort', onAbort);
      function finish(result: boolean) {
        clearTimeout(timer);
        unsubscribe();
        options.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      }
      check();
    });
    if (!settled) return null;
    const now = options.now?.() ?? new Date();
    const kindFolders = kindFoldersFromMarkers(index.getFolderMarkers());
    const documents = index.getDocuments();
    return projectHomeDigest({
      workspaceId,
      kindFolders,
      documents,
      items: taskItemsFromDocuments(workspaceId, documents, kindFolders),
      today: localDateOf(now),
      now,
    });
  } finally {
    index.dispose();
  }
}

export interface HomeDigests {
  /** The other workspaces, as their last digests describe them. */
  readonly summaries: readonly WorkspaceSummary[];
  /**
   * Change a workspace's saved digest after a change made to its files from
   * here (a task ticked off on Home), so it shows without reading the
   * workspace again. Nothing happens for a workspace with no digest.
   */
  readonly amend: (workspaceId: string, change: (digest: HomeDigest) => HomeDigest) => void;
}

export function useHomeDigests(input: {
  /** Off: nothing is read or saved. */
  readonly enabled: boolean;
  readonly activeWorkspaceId: string | null;
  /** The open workspace's digest, projected from its index; null while it is unknown. */
  readonly activeDigest: HomeDigest | null;
  /** Read other workspaces in the background (a page showing them is open). */
  readonly refreshOthers: boolean;
  readonly sources: HomeDigestSources;
}): HomeDigests {
  const { enabled, activeWorkspaceId, activeDigest, refreshOthers, sources } = input;
  const [workspaces, setWorkspaces] = useState<readonly DigestWorkspace[]>([]);
  const [stored, setStored] = useState<ReadonlyMap<string, HomeDigest>>(new Map());
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const attempted = useRef(new Set<string>());
  /** Amendments made to each workspace's digest, so a read begun before one is not kept over it. */
  const amendments = useRef(new Map<string, number>());

  /** Amended digests not saved yet. */
  const unsaved = useRef(new Set<string>());

  const amend = useCallback<HomeDigests['amend']>((workspaceId, change) => {
    amendments.current.set(workspaceId, (amendments.current.get(workspaceId) ?? 0) + 1);
    unsaved.current.add(workspaceId);
    setStored((current) => {
      const digest = current.get(workspaceId);
      return digest ? new Map(current).set(workspaceId, change(digest)) : current;
    });
  }, []);

  useEffect(() => {
    for (const workspaceId of unsaved.current) {
      const digest = stored.get(workspaceId);
      if (digest) void writeWorkspaceDigest(workspaceId, digest).catch(() => undefined);
    }
    unsaved.current.clear();
  }, [stored]);

  // Load the workspace list and every saved digest.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const [list, raw] = await Promise.all([
          sourcesRef.current.listWorkspaces(),
          readWorkspaceDigests().catch(() => new Map<string, unknown>()),
        ]);
        if (cancelled) return;
        const parsed = new Map<string, HomeDigest>();
        for (const workspace of list) {
          const digest = parseHomeDigest(raw.get(workspace.id), workspace.id);
          if (digest) parsed.set(workspace.id, digest);
        }
        setWorkspaces(list);
        setStored(parsed);
      } catch {
        // Without a list Home shows the open workspace alone.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, activeWorkspaceId]);

  // Save the open workspace's digest once it settles on something new.
  const lastSaved = useRef<HomeDigest | null>(null);
  useEffect(() => {
    if (!enabled || !activeDigest) return;
    if (sameHomeDigest(lastSaved.current, activeDigest)) return;
    const timer = setTimeout(() => {
      lastSaved.current = activeDigest;
      void writeWorkspaceDigest(activeDigest.workspaceId, activeDigest).catch(() => undefined);
      setStored((current) => new Map(current).set(activeDigest.workspaceId, activeDigest));
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, activeDigest]);

  // Read the stalest other workspace, one at a time, while asked to.
  useEffect(() => {
    if (!enabled || !refreshOthers || refreshing !== null) return;
    const now = Date.now();
    const next = workspaces.find((workspace) => {
      if (workspace.id === activeWorkspaceId || attempted.current.has(workspace.id)) return false;
      const digest = stored.get(workspace.id);
      return !digest || now - Date.parse(digest.madeAt) > FRESH_MS;
    });
    if (!next) return;
    attempted.current.add(next.id);
    setRefreshing(next.id);
    const abort = new AbortController();
    const amendedBefore = amendments.current.get(next.id) ?? 0;
    void (async () => {
      let opened: Awaited<ReturnType<HomeDigestSources['openSilently']>> = null;
      try {
        opened = await sourcesRef.current.openSilently(next.id);
        if (!opened || abort.signal.aborted) return;
        const digest = await digestWorkspaceOnce(next.id, opened.provider, {
          signal: abort.signal,
        });
        // A tick made while this read ran may be missing from what it saw.
        const amendedSince = (amendments.current.get(next.id) ?? 0) !== amendedBefore;
        if (digest && !abort.signal.aborted && !amendedSince) {
          await writeWorkspaceDigest(next.id, digest).catch(() => undefined);
          setStored((current) => new Map(current).set(next.id, digest));
        }
      } catch {
        // A workspace that cannot be read keeps its last digest.
      } finally {
        await opened?.release().catch(() => undefined);
        if (!abort.signal.aborted) setRefreshing(null);
      }
    })();
    return () => {
      abort.abort();
      setRefreshing(null);
    };
  }, [enabled, refreshOthers, refreshing, workspaces, stored, activeWorkspaceId]);

  const summaries = useMemo(
    () =>
      workspaces
        .filter((workspace) => workspace.id !== activeWorkspaceId)
        .map((workspace) => ({
          workspaceId: workspace.id,
          name: workspace.name,
          digest: stored.get(workspace.id) ?? null,
          refreshing: refreshing === workspace.id,
        })),
    [workspaces, stored, refreshing, activeWorkspaceId],
  );
  return useMemo(() => ({ summaries, amend }), [summaries, amend]);
}
