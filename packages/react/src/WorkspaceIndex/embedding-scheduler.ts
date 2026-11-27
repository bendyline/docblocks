import type {
  LiveEmbeddingProgress,
  LivePendingPassage,
  WorkspaceIndex,
} from '@bendyline/docblocks/workspace-index';

/**
 * Turns text into vectors with one embedding profile, on whatever runs the
 * model (a desktop utility process, a phone's native runtime).
 */
export interface WorkspaceIndexEmbedder {
  /** The embedding profile the vectors belong to, e.g. `bge-small-en-v1.5@1`. */
  readonly profileId: string;
  /**
   * Embed passages exactly as given, or queries with the profile's query
   * instruction applied by the embedder. One vector per text, in order.
   */
  embed(
    kind: 'passage' | 'query',
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly ArrayLike<number>[]>;
  /**
   * The profile's tokenizer files as text, so the index chunks in the
   * model's tokens. Without it the index uses character-sized chunks.
   */
  tokenizer?(): Promise<{ readonly definition: string; readonly config: string } | null>;
}

export interface SemanticProgress extends LiveEmbeddingProgress {
  /** Passages are being embedded right now. */
  readonly working: boolean;
}

interface EmbeddingStore {
  pendingEmbeddings(limit?: number): Promise<readonly LivePendingPassage[]>;
  storeEmbeddings(
    entries: ReadonlyArray<{ readonly hash: string; readonly vector: ArrayLike<number> }>,
  ): Promise<void>;
  embeddingStats(): Promise<LiveEmbeddingProgress>;
}

export interface EmbeddingSchedulerOptions {
  readonly store: EmbeddingStore;
  readonly embedder: WorkspaceIndexEmbedder;
  /** Its changes may add passages to embed. */
  readonly index: Pick<WorkspaceIndex, 'subscribe'>;
  readonly onProgress: (progress: SemanticProgress) => void;
  /** True while work should wait (the page is hidden, say). */
  readonly paused: () => boolean;
  readonly batchSize?: number;
  /** Test seam for the waits between batches. */
  readonly delays?: { readonly idle: number; readonly retry: number; readonly settle: number };
}

const DEFAULT_DELAYS = { idle: 60_000, retry: 30_000, settle: 1_000 };

/**
 * Embed the index's passages in the background, newest documents first,
 * one batch at a time: it waits while paused, backs off when the embedder
 * fails (a model still loading, say), and sleeps when nothing is left until
 * the index changes. Returns a stop function.
 */
export function startEmbeddingScheduler(options: EmbeddingSchedulerOptions): () => void {
  const delays = options.delays ?? DEFAULT_DELAYS;
  const batchSize = options.batchSize ?? 16;
  const controller = new AbortController();
  let stopped = false;
  let wake: (() => void) | null = null;
  let changed = false;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });
  // Index changes end an idle wait (after a short settle, so a burst of
  // analysis does not query on every publish).
  const unsubscribe = options.index.subscribe(() => {
    changed = true;
    if (wake) {
      const current = wake;
      wake = null;
      setTimeout(current, delays.settle);
    }
  });

  const progress = async (working: boolean) => {
    try {
      const stats = await options.store.embeddingStats();
      if (!stopped) options.onProgress({ ...stats, working });
    } catch {
      // Progress is informational.
    }
  };

  void (async () => {
    while (!stopped) {
      if (options.paused()) {
        await sleep(delays.settle * 5);
        continue;
      }
      changed = false;
      let pending: readonly LivePendingPassage[];
      try {
        pending = await options.store.pendingEmbeddings(batchSize);
      } catch {
        await sleep(delays.retry);
        continue;
      }
      if (stopped) return;
      if (pending.length === 0) {
        await progress(false);
        if (!changed) await sleep(delays.idle);
        continue;
      }
      try {
        const vectors = await options.embedder.embed(
          'passage',
          pending.map((passage) => passage.input),
          controller.signal,
        );
        if (stopped) return;
        if (vectors.length !== pending.length) throw new Error('The embedder skipped passages.');
        await options.store.storeEmbeddings(
          pending.map((passage, index) => ({
            hash: passage.hash,
            vector: vectors[index] as ArrayLike<number>,
          })),
        );
      } catch {
        if (stopped) return;
        await progress(false);
        await sleep(delays.retry);
        continue;
      }
      await progress(true);
    }
  })();

  return () => {
    stopped = true;
    controller.abort();
    unsubscribe();
    wake?.();
  };
}
