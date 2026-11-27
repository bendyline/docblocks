/**
 * The embedding utility process's request loop, separate from its entry so
 * it can be tested without ONNX Runtime. Main sends one request at a time;
 * the model loads on the first and stays loaded until the process is killed.
 */

export type EmbeddingUtilityRequest = {
  readonly type: 'embed';
  readonly id: string;
  /** Where the model files are, in transformers.js cache layout. Main-authoritative. */
  readonly modelDir: string;
  readonly kind: 'passage' | 'query';
  readonly texts: readonly string[];
};

export type EmbeddingUtilityReply =
  | { readonly type: 'done'; readonly id: string; readonly vectors: Float32Array[] }
  | { readonly type: 'error'; readonly id: string; readonly message: string };

export interface LoadedEmbedder {
  /** Passages exactly as given, one unit vector each. */
  embedPassages(texts: string[]): Promise<ArrayLike<number>[]>;
  /** One query with the profile's query instruction applied. */
  embedQuery(text: string): Promise<ArrayLike<number>>;
}

export type EmbedderLoader = (modelDir: string) => Promise<LoadedEmbedder>;

export class EmbeddingRuntime {
  private embedder: Promise<LoadedEmbedder> | null = null;
  private loadedFrom: string | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly load: EmbedderLoader) {}

  private embedderFor(modelDir: string): Promise<LoadedEmbedder> {
    if (!this.embedder || this.loadedFrom !== modelDir) {
      this.loadedFrom = modelDir;
      this.embedder = this.load(modelDir);
      // A failed load is retried by the next request rather than cached.
      this.embedder.catch(() => {
        if (this.loadedFrom === modelDir) this.embedder = null;
      });
    }
    return this.embedder;
  }

  handle(request: EmbeddingUtilityRequest, reply: (message: EmbeddingUtilityReply) => void): void {
    if (request?.type !== 'embed' || typeof request.id !== 'string') return;
    this.queue = this.queue.then(async () => {
      try {
        const embedder = await this.embedderFor(request.modelDir);
        const raw =
          request.kind === 'query'
            ? await Promise.all(request.texts.map((text) => embedder.embedQuery(text)))
            : await embedder.embedPassages([...request.texts]);
        if (raw.length !== request.texts.length) {
          throw new Error('The embedding model returned the wrong number of vectors.');
        }
        reply({ type: 'done', id: request.id, vectors: raw.map((row) => Float32Array.from(row)) });
      } catch (error: unknown) {
        reply({
          type: 'error',
          id: request.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }
}
