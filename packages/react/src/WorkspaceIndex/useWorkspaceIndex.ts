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
import type {
  WorkerEngine,
  WorkspaceIndex,
  WorkspaceIndexOptions as WorkspaceIndexCreateOptions,
  WorkspaceIndexStatus,
} from '@bendyline/docblocks/workspace-index';
import {
  startEmbeddingScheduler,
  type SemanticProgress,
  type WorkspaceIndexEmbedder,
} from './embedding-scheduler.js';

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
  /** How far semantic search has embedded the workspace; null when it is off. */
  readonly semantic: SemanticProgress | null;
  /** Start indexing now (a feature needs it), and catch up if not watching. */
  ensure(): void;
  /**
   * Delete the workspace's stored index and start over: it rebuilds when the
   * index is kept, and nothing is left on the device when it is not.
   */
  discard(): void;
}

/**
 * How an app runs the index's analysis and storage in a worker, which keeps
 * the index across launches (see `@bendyline/docblocks-react/workspace-index-worker`).
 */
export interface WorkspaceIndexWorkerOption {
  /** Names this app's stores, so two surfaces sharing an origin never share one. */
  readonly surface: string;
  /** A new worker running `startWorkspaceIndexWorker`. */
  create(): Worker;
}

export interface WorkspaceIndexOptions {
  readonly worker?: WorkspaceIndexWorkerOption | null;
  /** Keep the index across launches; false for a transient workspace. Default true. */
  readonly persist?: boolean;
  /**
   * Embeds passages and queries for semantic search; it needs the worker.
   * Without one, Best matches ranks by words alone.
   */
  readonly embedder?: WorkspaceIndexEmbedder | null;
  /**
   * Embed and rank by meaning now (default true). False pauses both without
   * rebuilding the index or dropping stored vectors.
   */
  readonly semanticEnabled?: boolean;
}

type WorkspaceIndexModule = typeof import('@bendyline/docblocks/workspace-index');

/**
 * The worker-backed engine with its larger limits, or null to index in page
 * memory as before. A worker that cannot start or open its store falls back
 * to the in-memory engine under page-sized text limits.
 */
function workerStore(
  module: WorkspaceIndexModule,
  option: WorkspaceIndexWorkerOption,
  workspaceId: string,
  persist: boolean,
  embedder: WorkspaceIndexEmbedder | null,
  tokenizer: { readonly definition: string; readonly config: string } | null,
  discard: boolean,
):
  | (Pick<WorkspaceIndexCreateOptions, 'engine' | 'limits'> & { readonly engine: WorkerEngine })
  | null {
  let worker: Worker;
  try {
    worker = option.create();
  } catch {
    return null;
  }
  if (persist) requestPersistentStorage();
  const engine = module.withMemoryFallback(
    module.createWorkerEngine(
      worker,
      {
        workspaceKey: `${option.surface}:${workspaceId}`,
        persist,
        ...(discard ? { discard: true } : {}),
        semantic: embedder ? { profileId: embedder.profileId, tokenizer } : null,
      },
      { onDispose: () => worker.terminate() },
    ),
    () =>
      module.createMemoryEngine({ maxCharacters: module.WORKSPACE_INDEX_LIMITS.maxTextCharacters }),
  );
  return { engine, limits: module.WORKSPACE_INDEX_STORE_LIMITS };
}

let persistenceRequested = false;
/**
 * Ask once for storage the browser will not evict under disk pressure, so a
 * large workspace's index is not silently rebuilt. Desktop grants it (its
 * permission policy allows `persistent-storage`); WKWebView answers false and
 * the index tolerates eviction. Workers cannot ask, so the page does.
 */
function requestPersistentStorage(): void {
  if (persistenceRequested) return;
  persistenceRequested = true;
  void globalThis.navigator?.storage?.persist?.().catch(() => false);
}

let indexModule: Promise<WorkspaceIndexModule> | null = null;
function loadWorkspaceIndexModule(): Promise<WorkspaceIndexModule> {
  indexModule ??= import('@bendyline/docblocks/workspace-index');
  return indexModule;
}

const IDLE_START_TIMEOUT_MS = 3_000;
const TOKENIZER_TIMEOUT_MS = 5_000;

/** The embedder's tokenizer, or null when it has none, fails, or is slow: never blocks indexing long. */
async function embedderTokenizer(
  embedder: WorkspaceIndexEmbedder | null,
): Promise<{ readonly definition: string; readonly config: string } | null> {
  if (!embedder?.tokenizer) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      embedder.tokenizer(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TOKENIZER_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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
  options: WorkspaceIndexOptions = {},
): WorkspaceIndexHandle {
  const providerV2 = provider && mode !== 'off' ? getFileSystemProviderV2(provider) : null;
  const worker = options.worker ?? null;
  const persist = options.persist ?? true;
  const embedder = (worker && options.embedder) || null;
  const semanticEnabledRef = useRef(options.semanticEnabled ?? true);
  semanticEnabledRef.current = options.semanticEnabled ?? true;
  const [index, setIndex] = useState<WorkspaceIndex | null>(null);
  const [semantic, setSemantic] = useState<SemanticProgress | null>(null);
  // `ensure()` can arrive while the module is still loading.
  const startRequestedRef = useRef(false);
  // `discard()` reopens the index once with its store deleted.
  const [discardRequest, setDiscardRequest] = useState(0);
  const discardRef = useRef(false);

  useEffect(() => {
    setIndex(null);
    setSemantic(null);
    startRequestedRef.current = false;
    if (!providerV2 || !workspaceId) return;
    let disposed = false;
    let created: WorkspaceIndex | null = null;
    let cancelIdle: (() => void) | null = null;
    let stopEmbedding: (() => void) | null = null;
    void Promise.all([
      loadWorkspaceIndexModule(),
      worker ? embedderTokenizer(embedder) : Promise.resolve(null),
    ])
      .then(([module, tokenizer]) => {
        if (disposed) return;
        // Taken only by the run that opens the store, not one disposed first.
        const discard = discardRef.current;
        discardRef.current = false;
        const store = worker
          ? workerStore(module, worker, workspaceId, persist, embedder, tokenizer, discard)
          : null;
        created = module.createWorkspaceIndex({
          workspaceId,
          source: providerV2,
          ...(store ?? {}),
          ...(store && embedder
            ? {
                embedQuery: async (query: string, signal: AbortSignal) => {
                  if (!semanticEnabledRef.current) throw new Error('Semantic search is off.');
                  const [vector] = await embedder.embed('query', [query], signal);
                  if (!vector) throw new Error('The embedder returned no vector.');
                  return vector;
                },
              }
            : {}),
        });
        setIndex(created);
        const instance = created;
        if (startRequestedRef.current) instance.start();
        else if (mode === 'eager') cancelIdle = whenIdle(() => instance.start());
        if (store && embedder) {
          stopEmbedding = startEmbeddingScheduler({
            store: store.engine,
            embedder,
            index: instance,
            onProgress: (progress) => {
              if (!disposed) setSemantic(progress);
            },
            paused: () => document.visibilityState === 'hidden' || !semanticEnabledRef.current,
          });
        }
      })
      .catch(() => {
        // Without the module there is simply no index; features degrade.
      });
    return () => {
      disposed = true;
      cancelIdle?.();
      stopEmbedding?.();
      created?.dispose();
    };
    // `discardRequest` only re-runs this effect; `discardRef` carries the request.
  }, [providerV2, workspaceId, mode, worker, persist, embedder, discardRequest]);

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

  const discard = useCallback(() => {
    discardRef.current = true;
    setDiscardRequest((count) => count + 1);
  }, []);

  return useMemo(
    () => ({ index, status, semantic, ensure, discard }),
    [index, status, semantic, ensure, discard],
  );
}
