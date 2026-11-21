import type { WorkspacePath } from '../filesystem/workspace-path.js';
import type { FileSystemVersion } from '../filesystem/v2.js';
import type { DocumentIdentity } from './analyze.js';
import type {
  EngineAnalysis,
  EngineSearchDocument,
  StoredDocument,
  WorkspaceIndexEngine,
} from './engine.js';
import type { LiveEmbeddingProgress, LivePassageHit, LivePendingPassage } from './live-engine.js';
import { createCheckpoint } from './search.js';
import type {
  WorkspaceFindOptions,
  WorkspaceSearchLimits,
  WorkspaceSearchQuery,
  WorkspaceSearchResult,
} from './types.js';

/**
 * A workspace index engine that runs in a Worker. The index itself stays on
 * the page (listing, change tracking, provider reads, which go through the
 * page's bridges); analysis, storage and search run in the worker, the only
 * place an origin-private SQLite pool can live.
 */

/**
 * The page's end of the channel: a Worker, or a MessagePort in tests. A
 * Worker also reports `error` when it dies, which fails what is pending.
 */
export interface EnginePort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error', listener: (event: Event) => void): void;
  removeEventListener(type: 'message' | 'error', listener: (event: Event) => void): void;
}

/** The worker's end: its global scope, or a MessagePort in tests. */
export interface EngineHost {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface WorkerEngineOpenRequest {
  /** Stable identity of the workspace on this device; selects its store. */
  readonly workspaceKey: string;
  /** Keep the index across launches; false for a transient workspace. */
  readonly persist: boolean;
  /**
   * Delete this workspace's stored index first: emptied when `persist` (the
   * index rebuilds), removed from the device when not. Only a worker that
   * holds the workspace's store does so, never one in a second window.
   */
  readonly discard?: boolean;
  /**
   * Store vectors for this embedding profile, for semantic search. Absent,
   * the index is lexical; switching re-chunks documents in the background.
   */
  readonly semantic?: {
    readonly profileId: string;
    /**
     * The profile's tokenizer files as text (`tokenizer.json`,
     * `tokenizer_config.json`), when the host supplies them; chunks are then
     * counted in the model's own tokens.
     */
    readonly tokenizer?: { readonly definition: string; readonly config: string } | null;
  } | null;
}

export interface WorkerEngineOpened {
  /** Whether the index survives this session ('memory' when another window owns it, say). */
  readonly persistence: 'persistent' | 'memory';
  /** Why a persistent index started empty, when it did. */
  readonly reset: 'created' | 'schema' | 'app' | null;
  /** Whether `find` ranks passages (false for the in-memory fallback). */
  readonly ranks: boolean;
}

export type WorkerFindOptions = WorkspaceFindOptions;

export interface WorkerEngine extends WorkspaceIndexEngine {
  /** Settles once the worker has opened its store; rejects if it could not. */
  readonly opened: Promise<WorkerEngineOpened>;
  /** Best-matching passages by BM25 over titles, headings and text (and meaning, with a vector). */
  find(query: string, options?: WorkerFindOptions): Promise<readonly LivePassageHit[]>;
  /** Passages awaiting vectors; empty for a lexical index. */
  pendingEmbeddings(limit?: number): Promise<readonly LivePendingPassage[]>;
  storeEmbeddings(
    entries: ReadonlyArray<{ readonly hash: string; readonly vector: ArrayLike<number> }>,
  ): Promise<void>;
  embeddingStats(): Promise<LiveEmbeddingProgress>;
}

type Request =
  | { readonly id: number; readonly op: 'open'; readonly request: WorkerEngineOpenRequest }
  | { readonly id: number; readonly op: 'restore' }
  | {
      readonly id: number;
      readonly op: 'analyze';
      readonly identity: DocumentIdentity;
      readonly version: FileSystemVersion;
      readonly data: ArrayBuffer;
      readonly maxParseBytes: number;
    }
  | { readonly id: number; readonly op: 'forget'; readonly path: WorkspacePath }
  | {
      readonly id: number;
      readonly op: 'search';
      readonly documents: readonly EngineSearchDocument[];
      readonly query: WorkspaceSearchQuery;
      readonly limits?: Partial<WorkspaceSearchLimits>;
    }
  | {
      readonly id: number;
      readonly op: 'find';
      readonly query: string;
      readonly options?: WorkerFindOptions;
    }
  | { readonly id: number; readonly op: 'pendingEmbeddings'; readonly limit?: number }
  | {
      readonly id: number;
      readonly op: 'storeEmbeddings';
      readonly entries: ReadonlyArray<{ readonly hash: string; readonly vector: Float32Array }>;
    }
  | { readonly id: number; readonly op: 'embeddingStats' }
  | { readonly id: number; readonly op: 'cancel'; readonly target: number }
  | { readonly id: number; readonly op: 'dispose' };

type Reply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: { readonly name: string; readonly message: string };
    };

type Outgoing = Request extends infer R ? (R extends Request ? Omit<R, 'id'> : never) : never;

function isReply(value: unknown): value is Reply {
  if (!value || typeof value !== 'object') return false;
  const reply = value as Partial<Reply> & { error?: unknown };
  return (
    typeof reply.id === 'number' &&
    (reply.ok === true ||
      (reply.ok === false &&
        !!reply.error &&
        typeof (reply.error as { message?: unknown }).message === 'string'))
  );
}

function abortError(): Error {
  return typeof DOMException === 'function'
    ? new DOMException('The search was cancelled.', 'AbortError')
    : Object.assign(new Error('The search was cancelled.'), { name: 'AbortError' });
}

/** The page side: a `WorkspaceIndexEngine` whose work happens in the worker behind `port`. */
export function createWorkerEngine(
  port: EnginePort,
  request: WorkerEngineOpenRequest,
  options: { readonly onDispose?: () => void } = {},
): WorkerEngine {
  let nextId = 1;
  let disposed = false;
  /** Set once the worker died or the engine closed; every later request fails with it. */
  let failure: Error | null = null;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();

  const fail = (error: Error) => {
    failure ??= error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  const listener = (event: Event) => {
    const data: unknown = (event as MessageEvent).data;
    if (!isReply(data)) return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) entry.resolve(data.value);
    else entry.reject(Object.assign(new Error(data.error.message), { name: data.error.name }));
  };
  // A worker that throws at top level or runs out of memory never replies.
  const onError = () => fail(new Error('The workspace index worker stopped.'));
  port.addEventListener('message', listener);
  port.addEventListener('error', onError);

  const send = <T>(
    message: Outgoing,
    transfer: Transferable[] = [],
  ): { readonly id: number; readonly result: Promise<T> } => {
    const id = nextId++;
    if (disposed || failure) {
      return {
        id,
        result: Promise.reject(failure ?? new Error('The workspace index engine is closed.')),
      };
    }
    const result = new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    port.postMessage({ ...message, id }, transfer);
    return { id, result };
  };

  const opened = send<WorkerEngineOpened>({ op: 'open', request }).result;
  // Every request waits for the store; if it never opens, each fails with that error.
  const call = async <T>(message: Outgoing, transfer?: Transferable[]): Promise<T> => {
    await opened;
    return send<T>(message, transfer).result;
  };

  return {
    opened,
    async restore() {
      const entries = await call<Array<readonly [WorkspacePath, StoredDocument]>>({
        op: 'restore',
      });
      return new Map(entries);
    },
    analyze(identity, version, data, analyzeOptions) {
      // Copied, then moved: the provider may still hold the buffer it returned.
      const copy = data.slice(0);
      return call<EngineAnalysis>(
        {
          op: 'analyze',
          identity,
          version,
          data: copy,
          maxParseBytes: analyzeOptions.maxParseBytes,
        },
        [copy],
      );
    },
    forget(path) {
      void call({ op: 'forget', path }).catch(() => undefined);
    },
    async search(documents, query, searchOptions) {
      await opened;
      const signal = searchOptions.signal;
      signal?.throwIfAborted();
      const { id, result } = send<WorkspaceSearchResult>({
        op: 'search',
        documents,
        query,
        limits: searchOptions.limits,
      });
      if (!signal) return result;
      // No reply comes for a cancel; the search itself settles.
      const onAbort = () => {
        if (!disposed && !failure) port.postMessage({ op: 'cancel', target: id, id: nextId++ });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        return await result;
      } catch (error: unknown) {
        if (signal.aborted) throw abortError();
        throw error;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
    find(query, findOptions) {
      const options = findOptions?.vector
        ? { ...findOptions, vector: Float32Array.from(findOptions.vector) }
        : findOptions;
      return call<readonly LivePassageHit[]>({ op: 'find', query, options });
    },
    pendingEmbeddings(limit) {
      return call<readonly LivePendingPassage[]>({ op: 'pendingEmbeddings', limit });
    },
    async storeEmbeddings(entries) {
      const vectors = entries.map(({ hash, vector }) => ({
        hash,
        vector: Float32Array.from(vector),
      }));
      await call(
        { op: 'storeEmbeddings', entries: vectors },
        vectors.map(({ vector }) => vector.buffer as ArrayBuffer),
      );
    },
    embeddingStats() {
      return call<LiveEmbeddingProgress>({ op: 'embeddingStats' });
    },
    dispose() {
      if (disposed) return;
      if (!failure) port.postMessage({ op: 'dispose', id: nextId++ });
      disposed = true;
      port.removeEventListener('message', listener);
      port.removeEventListener('error', onError);
      fail(new Error('The workspace index engine is closed.'));
      options.onDispose?.();
    },
  };
}

/**
 * The worker engine, or the in-memory one when the worker cannot open its
 * store (no origin-private storage, a blocked worker) or dies: indexing
 * then carries on for the session instead of leaving documents unsearched.
 * Documents analyzed by a worker that later died keep their records but
 * lose their text until they are read again.
 */
export function withMemoryFallback(
  primary: WorkerEngine,
  fallback: () => WorkspaceIndexEngine,
): WorkerEngine {
  let active: WorkspaceIndexEngine = primary;
  let usingFallback = false;
  const switchOver = () => {
    if (usingFallback) return;
    usingFallback = true;
    primary.dispose();
    active = fallback();
  };
  const ready = primary.opened.then(() => undefined, switchOver);
  /** Run on the active engine; if the worker fails underneath, switch and retry once. */
  const run = async <T>(work: (engine: WorkspaceIndexEngine) => Promise<T>): Promise<T> => {
    await ready;
    try {
      return await work(active);
    } catch (error: unknown) {
      if (usingFallback || (error as Error)?.name === 'AbortError') throw error;
      if (!/worker stopped/.test((error as Error)?.message ?? '')) throw error;
      switchOver();
      return work(active);
    }
  };
  return {
    opened: primary.opened.catch(
      (): WorkerEngineOpened => ({ persistence: 'memory', reset: null, ranks: false }),
    ),
    restore: () => run((engine) => engine.restore()),
    analyze: (identity, version, data, options) =>
      run((engine) => engine.analyze(identity, version, data, options)),
    forget(path) {
      void ready.then(() => active.forget(path));
    },
    search: (documents, query, options) =>
      run((engine) => engine.search(documents, query, options)),
    async find(query, options) {
      await ready;
      return usingFallback ? [] : primary.find(query, options).catch(() => []);
    },
    // The in-memory stand-in keeps no vectors: nothing to embed, nothing stored.
    async pendingEmbeddings(limit) {
      await ready;
      return usingFallback ? [] : primary.pendingEmbeddings(limit);
    },
    async storeEmbeddings(entries) {
      await ready;
      if (!usingFallback) await primary.storeEmbeddings(entries);
    },
    async embeddingStats() {
      await ready;
      return usingFallback ? { total: 0, embedded: 0 } : primary.embeddingStats();
    },
    dispose() {
      primary.dispose();
      if (usingFallback) active.dispose();
    },
  };
}

/** What the worker opens for a workspace. */
export interface ServedEngine {
  readonly engine: WorkspaceIndexEngine & {
    find?(query: string, options?: WorkerFindOptions): readonly LivePassageHit[];
    pendingEmbeddings?(limit?: number): readonly LivePendingPassage[];
    storeEmbeddings?(
      entries: ReadonlyArray<{ readonly hash: string; readonly vector: ArrayLike<number> }>,
    ): void;
    embeddingStats?(): LiveEmbeddingProgress;
  };
  readonly opened: WorkerEngineOpened;
}

/**
 * The worker side: answer the page's engine requests in arrival order with
 * the engine `open` returns. Cancellations skip the queue, so a long search
 * stops at its next slice.
 */
export function serveWorkspaceIndexEngine(
  host: EngineHost,
  open: (request: WorkerEngineOpenRequest) => Promise<ServedEngine>,
): void {
  let served: ServedEngine | null = null;
  const searches = new Map<number, AbortController>();
  let queue: Promise<void> = Promise.resolve();
  const yieldToEvents = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const engine = () => {
    if (!served) throw new Error('The workspace index store is not open.');
    return served.engine;
  };

  const dispatch = async (message: Request): Promise<unknown> => {
    switch (message.op) {
      case 'open':
        served?.engine.dispose();
        served = await open(message.request);
        return served.opened;
      case 'restore':
        return [...(await engine().restore()).entries()];
      case 'analyze':
        return engine().analyze(message.identity, message.version, message.data, {
          maxParseBytes: message.maxParseBytes,
        });
      case 'forget':
        engine().forget(message.path);
        return null;
      case 'search': {
        const controller = new AbortController();
        searches.set(message.id, controller);
        try {
          return await engine().search(message.documents, message.query, {
            checkpoint: createCheckpoint(yieldToEvents, now, controller.signal),
            limits: message.limits,
            signal: controller.signal,
          });
        } finally {
          searches.delete(message.id);
        }
      }
      case 'find': {
        const current = engine();
        if (!current.find) throw new Error('This workspace index cannot rank passages.');
        return current.find(message.query, message.options);
      }
      case 'pendingEmbeddings':
        return engine().pendingEmbeddings?.(message.limit) ?? [];
      case 'storeEmbeddings': {
        const current = engine();
        if (!current.storeEmbeddings) throw new Error('This workspace index keeps no vectors.');
        current.storeEmbeddings(message.entries);
        return null;
      }
      case 'embeddingStats':
        return engine().embeddingStats?.() ?? { total: 0, embedded: 0 };
      case 'dispose':
        served?.engine.dispose();
        served = null;
        return null;
      case 'cancel':
        return null;
    }
  };

  host.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as Request;
    if (!message || typeof message !== 'object' || typeof message.id !== 'number') return;
    if (message.op === 'cancel') {
      searches.get(message.target)?.abort();
      return;
    }
    queue = queue.then(async () => {
      try {
        host.postMessage({ id: message.id, ok: true, value: await dispatch(message) });
      } catch (error: unknown) {
        const failure = error instanceof Error ? error : new Error(String(error));
        host.postMessage({
          id: message.id,
          ok: false,
          error: { name: failure.name, message: failure.message },
        });
      }
    });
  });
}
