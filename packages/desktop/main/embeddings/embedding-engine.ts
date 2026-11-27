import type { EmbeddingUtilityReply, EmbeddingUtilityRequest } from './embedding-runtime.js';

/**
 * Main's side of the embedding model: owns the utility process, sends it one
 * batch at a time, and keeps it healthy. Queries go ahead of queued passage
 * batches, so a search never waits behind background indexing for more than
 * the batch already running.
 */

export interface EmbeddingChannel {
  postMessage(message: EmbeddingUtilityRequest): void;
  onMessage(listener: (reply: EmbeddingUtilityReply) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}

export interface EmbeddingEngineOptions {
  readonly fork: () => EmbeddingChannel;
  readonly modelDir: string;
  /** Allowed time for a batch that also loads the model. */
  readonly loadTimeoutMs?: number;
  /** Allowed time for a batch once the model is loaded. */
  readonly batchTimeoutMs?: number;
  readonly idleUnloadMs?: number;
  readonly now?: () => number;
}

export class EmbeddingEngineError extends Error {
  constructor(
    readonly code: 'engine-failed' | 'timeout' | 'cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'EmbeddingEngineError';
  }
}

interface Job {
  readonly kind: 'passage' | 'query';
  readonly texts: readonly string[];
  readonly signal: AbortSignal | undefined;
  readonly resolve: (vectors: Float32Array[]) => void;
  readonly reject: (error: EmbeddingEngineError) => void;
}

const RESPAWN_WINDOW_MS = 60_000;
const MAX_SPAWNS_PER_WINDOW = 3;

export class EmbeddingEngine {
  private channel: EmbeddingChannel | null = null;
  private loaded = false;
  private readonly queue: Job[] = [];
  private running: {
    readonly id: string;
    readonly job: Job;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private spawns: number[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;
  private disposed = false;

  constructor(private readonly options: EmbeddingEngineOptions) {}

  embed(
    kind: 'passage' | 'query',
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    if (this.disposed) {
      return Promise.reject(
        new EmbeddingEngineError('cancelled', 'The embedding model is closed.'),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(new EmbeddingEngineError('cancelled', 'Embedding stopped.'));
    }
    return new Promise((resolve, reject) => {
      const job: Job = { kind, texts, signal, resolve, reject };
      signal?.addEventListener(
        'abort',
        () => {
          const queued = this.queue.indexOf(job);
          if (queued !== -1) this.queue.splice(queued, 1);
          // A running batch cannot be interrupted; its reply is dropped.
          reject(new EmbeddingEngineError('cancelled', 'Embedding stopped.'));
        },
        { once: true },
      );
      this.queue.push(job);
      this.pump();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.clearIdle();
    const error = new EmbeddingEngineError('cancelled', 'The embedding model is closed.');
    for (const job of this.queue.splice(0)) job.reject(error);
    this.finishRunning()?.reject(error);
    this.discard();
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  private ensureChannel(): EmbeddingChannel {
    if (this.channel) return this.channel;
    const now = this.now;
    this.spawns = this.spawns.filter((at) => now - at < RESPAWN_WINDOW_MS);
    if (this.spawns.length >= MAX_SPAWNS_PER_WINDOW) {
      throw new EmbeddingEngineError(
        'engine-failed',
        'The embedding model keeps stopping. Semantic search will try again in a minute.',
      );
    }
    this.spawns.push(now);
    const channel = this.options.fork();
    this.loaded = false;
    channel.onMessage((reply) => {
      if (this.channel !== channel || this.running?.id !== reply?.id) return;
      const job = this.finishRunning();
      if (!job) return;
      if (reply.type === 'done') {
        this.loaded = true;
        job.resolve(reply.vectors);
      } else {
        job.reject(new EmbeddingEngineError('engine-failed', reply.message));
      }
      this.pump();
    });
    channel.onExit(() => {
      if (this.channel !== channel) return;
      this.channel = null;
      this.finishRunning()?.reject(
        new EmbeddingEngineError('engine-failed', 'The embedding model stopped.'),
      );
      this.pump();
    });
    this.channel = channel;
    return channel;
  }

  private finishRunning(): Job | null {
    const running = this.running;
    if (!running) return null;
    clearTimeout(running.timer);
    this.running = null;
    return running.job;
  }

  private next(): Job | null {
    const query = this.queue.findIndex((job) => job.kind === 'query');
    const index = query === -1 ? 0 : query;
    return this.queue.length > 0 ? (this.queue.splice(index, 1)[0] ?? null) : null;
  }

  private pump(): void {
    if (this.running || this.disposed) return;
    const job = this.next();
    if (!job) {
      this.armIdle();
      return;
    }
    this.clearIdle();
    let channel: EmbeddingChannel;
    try {
      channel = this.ensureChannel();
    } catch (error: unknown) {
      job.reject(error as EmbeddingEngineError);
      // Fail what is queued too: nothing can run until the window passes.
      for (const queued of this.queue.splice(0)) queued.reject(error as EmbeddingEngineError);
      return;
    }
    this.sequence += 1;
    const id = `embed-${this.sequence}`;
    const timeout = this.loaded
      ? (this.options.batchTimeoutMs ?? 60_000)
      : (this.options.loadTimeoutMs ?? 3 * 60_000);
    const timer = setTimeout(() => {
      const stalled = this.finishRunning();
      // A wedged inference cannot be interrupted; replace the process.
      this.discard();
      stalled?.reject(
        new EmbeddingEngineError('timeout', 'The embedding model stopped responding.'),
      );
      this.pump();
    }, timeout);
    this.running = { id, job, timer };
    channel.postMessage({
      type: 'embed',
      id,
      modelDir: this.options.modelDir,
      kind: job.kind,
      texts: [...job.texts],
    });
  }

  private discard(): void {
    const channel = this.channel;
    this.channel = null;
    this.loaded = false;
    channel?.kill();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdle(): void {
    this.clearIdle();
    if (!this.channel) return;
    this.idleTimer = setTimeout(
      () => {
        // Unloading frees the model's memory (~200 MB); the next batch reloads it.
        if (!this.running && this.queue.length === 0) this.discard();
      },
      this.options.idleUnloadMs ?? 2 * 60_000,
    );
    this.idleTimer.unref?.();
  }
}
