/**
 * `@bendyline/docblocks-react/workspace-index-worker`: the worker half of a
 * persistent workspace index. An app's worker file calls
 * `startWorkspaceIndexWorker(self, { sqliteWasmUrl })`; the page half is the
 * shell's `workspaceIndexWorker` prop.
 *
 * Each workspace's index lives in its own origin-private SQLite pool, owned
 * by one worker at a time through a Web Lock. A second window on the same
 * workspace, a transient workspace, a device without origin-private storage,
 * or a store that will not open gets the same engine over an in-memory
 * database for the session.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { Tokenizer } from '@huggingface/tokenizers';
import {
  KNOWLEDGE_EMBEDDING_PROFILES,
  LiveIndex,
  type LiveIndexOptions,
  liveIndexEmbedding,
  markdownChunksByCharacters,
} from '@bendyline/gezel-retrieval';
import {
  openMemoryDatabase,
  openPoolDatabase,
  type WasmSqlDatabase,
  type WasmSqlite3,
} from '@bendyline/gezel-retrieval/sqlite-wasm';
import {
  LIVE_ENGINE_PAYLOAD_FORMAT,
  createLiveIndexEngine,
  serveWorkspaceIndexEngine,
  type EngineHost,
  type ServedEngine,
  type WorkerEngineOpenRequest,
} from '@bendyline/docblocks/workspace-index';

/** Bumped with any change to what DocBlocks stores; an older index starts empty. */
export const WORKSPACE_INDEX_STORE_FORMAT = `docblocks-workspace-index@1/${LIVE_ENGINE_PAYLOAD_FORMAT}`;

export interface WorkspaceIndexWorkerOptions {
  /** Where the app serves `sqlite3.wasm`; omitted, sqlite-wasm looks beside its own module. */
  readonly sqliteWasmUrl?: string;
  /**
   * The tokenizer of each embedding profile the app embeds with, by profile
   * id: where it serves `tokenizer.json` and `tokenizer_config.json`.
   * Semantic search chunks and builds embed inputs with it, as catalogs do.
   */
  readonly tokenizers?: Readonly<
    Record<string, { readonly definitionUrl: string; readonly configUrl: string }>
  >;
}

let sqliteModule: Promise<WasmSqlite3> | null = null;
function loadSqlite(options: WorkspaceIndexWorkerOptions): Promise<WasmSqlite3> {
  sqliteModule ??= (sqlite3InitModule as unknown as (config: object) => Promise<WasmSqlite3>)({
    print: () => undefined,
    printErr: () => undefined,
    ...(options.sqliteWasmUrl ? { locateFile: () => options.sqliteWasmUrl } : {}),
  });
  return sqliteModule;
}

/**
 * How long a worker waits for its workspace's store: long enough for the
 * worker it replaces in this window (the index reopened) to be gone, short
 * enough that a second window soon settles for an in-memory index.
 */
const LOCK_WAIT_MS = 1_500;

/** Hold `name` for this worker's lifetime, unless another context keeps it. */
function holdLock(name: string): Promise<boolean> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (typeof locks?.request !== 'function') return Promise.resolve(true);
  const signal =
    typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(LOCK_WAIT_MS) : undefined;
  return new Promise((resolve) => {
    locks
      .request(name, signal ? { signal } : { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        // Released when the worker is terminated.
        return lock ? new Promise<void>(() => undefined) : undefined;
      })
      // The wait ran out: another window holds the store.
      .catch(() => resolve(false));
  });
}

/** The parts of sqlite-wasm's pool utility that delete a store. */
interface DisposablePool {
  wipeFiles?(): Promise<void>;
  removeVfs?(): Promise<boolean>;
}

/** A short, stable, filename-safe name for a workspace's store. */
async function storeName(workspaceKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(workspaceKey));
  return [...new Uint8Array(digest).slice(0, 12)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function openPersistent(
  sqlite3: WasmSqlite3,
  request: WorkerEngineOpenRequest,
): Promise<WasmSqlDatabase | null> {
  if (!request.persist && !request.discard) return null;
  const name = await storeName(request.workspaceKey);
  // Without the store, leave it alone: it is another window's to keep or delete.
  if (!(await holdLock(`docblocks-index:${name}`))) return null;
  const pool = `docblocks-index-${name}`;
  try {
    if (request.discard) {
      const installed = (await sqlite3.installOpfsSAHPoolVfs?.({ name: pool })) as
        | DisposablePool
        | undefined;
      if (!request.persist) {
        // Keeping turned off: nothing of the index stays on the device.
        await installed?.removeVfs?.();
        return null;
      }
      await installed?.wipeFiles?.();
    }
    const { db } = await openPoolDatabase(sqlite3, { pool, filename: '/index.sqlite3' });
    return db;
  } catch {
    return null;
  }
}

type TokenizerSource =
  | { readonly definitionUrl: string; readonly configUrl: string }
  | { readonly definition: string; readonly config: string };

async function loadTokenizer(source: TokenizerSource): Promise<(text: string) => number> {
  const json = async (url: string): Promise<object> => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load the tokenizer (${response.status}).`);
    return (await response.json()) as object;
  };
  const [definition, config] =
    'definition' in source
      ? [JSON.parse(source.definition) as object, JSON.parse(source.config) as object]
      : await Promise.all([json(source.definitionUrl), json(source.configUrl)]);
  const tokenizer = new Tokenizer(definition, config);
  return (text) => tokenizer.encode(text, { add_special_tokens: false }).ids.length;
}

/**
 * How documents are chunked: for semantic search, the profile's catalog
 * chunking counted with its tokenizer; otherwise character chunks, which
 * need nothing loaded. A tokenizer that will not load leaves search lexical.
 */
async function indexShape(
  options: WorkspaceIndexWorkerOptions,
  request: WorkerEngineOpenRequest,
): Promise<Pick<LiveIndexOptions, 'chunking' | 'embedding'>> {
  const profileId = request.semantic?.profileId;
  const profile = KNOWLEDGE_EMBEDDING_PROFILES.find((candidate) => candidate.id === profileId);
  // The host's own files first (desktop), else where the app serves them.
  const source: TokenizerSource | undefined =
    request.semantic?.tokenizer ?? (profileId ? options.tokenizers?.[profileId] : undefined);
  if (profile && source) {
    try {
      return liveIndexEmbedding(profile, await loadTokenizer(source));
    } catch {
      // Fall through to a lexical index.
    }
  }
  return { chunking: markdownChunksByCharacters() };
}

const RECHUNK_BATCH = 25;

/** Re-chunk documents from an earlier chunking or profile, a few at a time, while open. */
function keepRechunking(live: LiveIndex, isOpen: () => boolean): void {
  const step = () => {
    if (!isOpen()) return;
    try {
      if (live.rechunkStale(RECHUNK_BATCH) > 0) setTimeout(step, 0);
    } catch {
      // The store closed underneath; nothing left to do.
    }
  };
  setTimeout(step, 0);
}

async function openEngine(
  options: WorkspaceIndexWorkerOptions,
  request: WorkerEngineOpenRequest,
): Promise<ServedEngine> {
  const sqlite3 = await loadSqlite(options);
  const persistent = await openPersistent(sqlite3, request);
  const shape = await indexShape(options, request);
  const serve = (database: WasmSqlDatabase, persistence: 'persistent' | 'memory'): ServedEngine => {
    const live = LiveIndex.open(database, { ...shape, appVersion: WORKSPACE_INDEX_STORE_FORMAT });
    let open = true;
    keepRechunking(live, () => open);
    return {
      engine: createLiveIndexEngine(live, {
        onDispose: () => {
          open = false;
          database.close();
        },
      }),
      opened: { persistence, reset: persistence === 'persistent' ? live.reset : null, ranks: true },
    };
  };
  if (persistent) {
    try {
      return serve(persistent, 'persistent');
    } catch {
      // An unreadable store: index in memory this session rather than not at all.
      persistent.close();
    }
  }
  return serve(openMemoryDatabase(sqlite3), 'memory');
}

export function startWorkspaceIndexWorker(
  host: EngineHost,
  options: WorkspaceIndexWorkerOptions = {},
): void {
  serveWorkspaceIndexEngine(host, (request) => openEngine(options, request));
}
