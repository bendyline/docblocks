/**
 * `host.embeddings`: turn text into vectors with the host's embedding model,
 * for semantic workspace search. Independent of `host.ai` — the model runs
 * in the host and needs no provider connection — and absent on a host that
 * ships no model.
 *
 * Values from the host are re-parsed on the renderer side: a vector is a
 * plain `Float32Array` of the profile's width, one per text, in order.
 */

/** What a vector is for: a passage to store, or a query to search with. */
export type EmbeddingKind = 'passage' | 'query';

export interface EmbeddingsRequest {
  readonly kind: EmbeddingKind;
  /** Passages exactly as stored (already carrying their context header), or raw queries. */
  readonly texts: readonly string[];
}

export interface EmbeddingsStatus {
  /** The embedding profile this host's vectors belong to, e.g. `bge-small-en-v1.5@1`. */
  readonly profileId: string;
  /** Vector width. */
  readonly dimensions: number;
  /**
   * `download-required` and `downloading` only on a host whose model is not
   * in the app (a phone): `prepare()` downloads it.
   */
  readonly state: 'ready' | 'download-required' | 'downloading' | 'unavailable';
  /** Plain-language reason when unavailable, or why the last download stopped. */
  readonly reason: string | null;
  /** The model download's size and progress; null on a host that bundles the model. */
  readonly download: { readonly receivedBytes: number; readonly totalBytes: number } | null;
}

const EMBEDDINGS_STATES: ReadonlySet<string> = new Set([
  'ready',
  'download-required',
  'downloading',
  'unavailable',
]);

/** The profile's tokenizer files, as text, so chunking counts tokens as the model does. */
export interface EmbeddingsTokenizer {
  /** `tokenizer.json`. */
  readonly definition: string;
  /** `tokenizer_config.json`. */
  readonly config: string;
}

export interface DocBlocksHostEmbeddingsAPI {
  status(): Promise<EmbeddingsStatus>;
  /**
   * One vector per text, in order. Queries get the profile's query
   * instruction from the host; passages are embedded as given.
   */
  embed(request: EmbeddingsRequest): Promise<Float32Array[]>;
  /** The profile's tokenizer; null when the host cannot supply it. */
  tokenizer(): Promise<EmbeddingsTokenizer | null>;
  /**
   * Download the model, on a host that does not bundle it. Resolves once it
   * is installed; `status()` reports progress meanwhile.
   */
  prepare?(): Promise<void>;
}

export const EMBEDDINGS_WIRE_LIMITS = Object.freeze({
  texts: 32,
  /** The embedder caps input at 8,000 characters; anything longer is cut there anyway. */
  textCharacters: 8_000,
  totalCharacters: 128_000,
  profileIdCharacters: 128,
  reasonCharacters: 512,
  maxDimensions: 4_096,
  /** bge's tokenizer.json is ~0.7 MB; larger vocabularies stay well under this. */
  tokenizerCharacters: 32 * 1024 * 1024,
});

const PROFILE_ID = /^[A-Za-z0-9._-]+@[0-9]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}

/** Main-side: an embed request from the renderer, or null. */
export function parseEmbeddingsRequest(value: unknown): EmbeddingsRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'texts'])) return null;
  const { kind, texts } = value;
  if (kind !== 'passage' && kind !== 'query') return null;
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > EMBEDDINGS_WIRE_LIMITS.texts) {
    return null;
  }
  let total = 0;
  for (const text of texts) {
    if (typeof text !== 'string' || text.length > EMBEDDINGS_WIRE_LIMITS.textCharacters) {
      return null;
    }
    if (text.includes('\0')) return null;
    total += text.length;
  }
  if (total > EMBEDDINGS_WIRE_LIMITS.totalCharacters) return null;
  return { kind, texts: [...(texts as string[])] };
}

/** Renderer-side: the host's status, or null. */
export function parseEmbeddingsStatus(value: unknown): EmbeddingsStatus | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['profileId', 'dimensions', 'state', 'reason', 'download'])
  ) {
    return null;
  }
  const { profileId, dimensions, state, reason, download } = value;
  if (
    typeof profileId !== 'string' ||
    profileId.length > EMBEDDINGS_WIRE_LIMITS.profileIdCharacters ||
    !PROFILE_ID.test(profileId)
  ) {
    return null;
  }
  if (
    typeof dimensions !== 'number' ||
    !Number.isInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > EMBEDDINGS_WIRE_LIMITS.maxDimensions
  ) {
    return null;
  }
  if (typeof state !== 'string' || !EMBEDDINGS_STATES.has(state)) return null;
  if (
    reason !== null &&
    (typeof reason !== 'string' || reason.length > EMBEDDINGS_WIRE_LIMITS.reasonCharacters)
  ) {
    return null;
  }
  let progress: EmbeddingsStatus['download'] = null;
  if (download !== null) {
    if (!isRecord(download) || !hasExactKeys(download, ['receivedBytes', 'totalBytes'])) {
      return null;
    }
    const { receivedBytes, totalBytes } = download;
    const bytes = (n: unknown): n is number =>
      typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
    if (!bytes(receivedBytes) || !bytes(totalBytes)) return null;
    progress = { receivedBytes, totalBytes };
  }
  return {
    profileId,
    dimensions,
    state: state as EmbeddingsStatus['state'],
    reason,
    download: progress,
  };
}

/**
 * Renderer-side: exactly `count` finite vectors of `dimensions` each, or
 * null. Accepts plain number arrays too (a structured clone of either).
 */
export function parseEmbeddingsVectors(
  value: unknown,
  count: number,
  dimensions: number,
): Float32Array[] | null {
  if (!Array.isArray(value) || value.length !== count) return null;
  const vectors: Float32Array[] = [];
  for (const item of value) {
    const vector =
      item instanceof Float32Array
        ? item
        : Array.isArray(item) && item.every((entry) => typeof entry === 'number')
          ? Float32Array.from(item as number[])
          : null;
    if (!vector || vector.length !== dimensions) return null;
    for (const entry of vector) if (!Number.isFinite(entry)) return null;
    vectors.push(vector);
  }
  return vectors;
}

/** Renderer-side: tokenizer files, or null. */
export function parseEmbeddingsTokenizer(value: unknown): EmbeddingsTokenizer | null {
  if (!isRecord(value) || !hasExactKeys(value, ['definition', 'config'])) return null;
  const { definition, config } = value;
  if (typeof definition !== 'string' || typeof config !== 'string') return null;
  if (definition.length + config.length > EMBEDDINGS_WIRE_LIMITS.tokenizerCharacters) return null;
  return { definition, config };
}
