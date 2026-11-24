import { tryParseFileSystemVersion } from '../filesystem/v2.js';
import type { WorkspacePath } from '../filesystem/workspace-path.js';
import { DOCUMENT_ANALYZER_REVISION, analyzeDocumentBytes } from './analyze.js';
import type { StoredDocument, WorkspaceIndexEngine } from './engine.js';
import type { SearchText } from './search-text.js';
import { buildLiteralMatcher, searchDocuments, type SearchableDocument } from './search.js';
import type {
  IndexedDocument,
  WorkspaceFindOptions,
  WorkspacePassageHit,
  WorkspaceSearchLineKind,
  WorkspaceSearchQuery,
} from './types.js';

/**
 * What the persistent engine needs from `@bendyline/gezel-retrieval`'s
 * `LiveIndex`. Structural, so core does not depend on Gezel: the host that
 * owns the SQLite database opens the live index and hands it in.
 */
export interface LiveIndexLike {
  upsert(input: {
    readonly path: string;
    readonly version: string;
    readonly title: string;
    readonly body: string;
    readonly payload?: Uint8Array | null;
  }): unknown;
  remove(path: string): boolean;
  get(path: string): { readonly payload: Uint8Array | null } | null;
  /** The body as indexed, or null; absent on an older live index. */
  body?(path: string): string | null;
  documents(batchSize?: number): Iterable<{
    readonly path: string;
    readonly version: string;
    readonly payload: Uint8Array | null;
  }>;
  search(query: string, options?: WorkspaceFindOptions): readonly LiveIndexHit[];
  /** Lexical and semantic hits fused; lexical alone without a vector. */
  hybridSearch(
    query: string,
    vector: ArrayLike<number> | null,
    options?: WorkspaceFindOptions,
  ): readonly LiveIndexHit[];
  /** Full passage text by chunk id; absent on an older live index. */
  passageTexts?(chunks: readonly number[]): ReadonlyMap<number, string>;
  pendingEmbeddings(limit?: number): readonly LivePendingPassage[];
  storeEmbeddings(
    entries: ReadonlyArray<{ readonly hash: string; readonly vector: ArrayLike<number> }>,
  ): void;
  embeddingStats(): LiveEmbeddingProgress;
  /** Re-chunk documents indexed under an earlier chunking or profile; how many it did. */
  rechunkStale(limit?: number): number;
}

/** A hit as the live index returns it: a passage plus where it came from. */
export interface LiveIndexHit extends Omit<WorkspacePassageHit, 'meaning' | 'text'> {
  /** The passage's chunk id. */
  readonly chunk?: number;
  /** Cosine similarity to the query, for a hit the vector arm found. */
  readonly similarity?: number;
  /** Rank in each arm that found the hit, for a hybrid search. */
  readonly arms?: { readonly lexical?: number; readonly vector?: number };
}

/** Passage text quoted to a model is capped; a passage is ~420 tokens. */
const MAX_PASSAGE_TEXT = 4_000;

/** A passage awaiting its vector: embed `input`, store the result under `hash`. */
export interface LivePendingPassage {
  readonly hash: string;
  readonly input: string;
}

/** Passages with a vector out of those that need one. */
export interface LiveEmbeddingProgress {
  readonly total: number;
  readonly embedded: number;
}

/** A ranked passage, as the live index reports it. */
export type LivePassageHit = WorkspacePassageHit;

export interface LiveIndexEngine extends WorkspaceIndexEngine {
  /**
   * Best-matching passages: BM25 over titles, headings and text, fused with
   * the nearest passages in meaning when `options.vector` holds the query's
   * embedding.
   */
  find(query: string, options?: WorkspaceFindOptions): readonly WorkspacePassageHit[];
  pendingEmbeddings(limit?: number): readonly LivePendingPassage[];
  storeEmbeddings(
    entries: ReadonlyArray<{ readonly hash: string; readonly vector: ArrayLike<number> }>,
  ): void;
  embeddingStats(): LiveEmbeddingProgress;
  /** Re-chunk up to `limit` stale documents; 0 when none are left. */
  rechunk(limit?: number): number;
}

/**
 * Bumped when the stored payload changes shape; the host passes it as part
 * of the live index's `appVersion`, so an older index starts empty.
 *
 * A record gaining optional fields is not a change of shape: the payload
 * records which analyzer revision built it (`analyzer`), and the index brings
 * older records up to date one document at a time instead.
 */
export const LIVE_ENGINE_PAYLOAD_FORMAT = 1;

interface StoredPayload {
  readonly format: typeof LIVE_ENGINE_PAYLOAD_FORMAT;
  /** `DOCUMENT_ANALYZER_REVISION` when `record` was built; absent before revision 2. */
  readonly analyzer?: number;
  readonly record: IndexedDocument;
  readonly characters: number;
  readonly text: {
    readonly lines: readonly string[];
    readonly sourceLines: readonly number[];
    readonly kinds: readonly WorkspaceSearchLineKind[];
  } | null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodePayload(
  record: IndexedDocument,
  characters: number,
  text: SearchText | null,
): Uint8Array {
  const payload: StoredPayload = {
    format: LIVE_ENGINE_PAYLOAD_FORMAT,
    analyzer: DOCUMENT_ANALYZER_REVISION,
    record,
    characters,
    text: text ? { lines: text.lines, sourceLines: text.sourceLines, kinds: text.kinds } : null,
  };
  return encoder.encode(JSON.stringify(payload));
}

/** A stored payload, or null when it is missing or not one this engine wrote. */
function decodePayload(bytes: Uint8Array | null | undefined): StoredPayload | null {
  return bytes ? decodePayloadText(decoder.decode(bytes)) : null;
}

function decodePayloadText(json: string): StoredPayload | null {
  try {
    const value = JSON.parse(json) as Partial<StoredPayload>;
    if (
      value.format !== LIVE_ENGINE_PAYLOAD_FORMAT ||
      !value.record ||
      typeof value.record.path !== 'string' ||
      typeof value.characters !== 'number'
    ) {
      return null;
    }
    return value as StoredPayload;
  } catch {
    return null;
  }
}

/** Text with no lines: what a document the screen rules out is searched as. */
const NO_TEXT: SearchText = { lines: [], sourceLines: [], kinds: [], characters: 0 };

/** Characters JSON writes escaped, so a stored payload does not hold them as typed. */
// eslint-disable-next-line no-control-regex
const JSON_ESCAPED = /["\\\u0000-\u001f]|[\ud800-\udfff]/u;

/**
 * A test that a stored payload, as raw JSON, might hold a match: the literal
 * query's own pattern and case rule, run over the whole payload before it is
 * parsed. Every search-text line sits in the JSON verbatim apart from
 * escapes, so a document it rejects has no matching line; it only lets
 * through extra (a match in the record, across lines, or not on a word
 * boundary), which the real search then rules out. Null for a query holding
 * a character JSON escapes, which the raw text would not show as typed.
 */
function payloadScreen(query: WorkspaceSearchQuery, maxQueryCharacters?: number): RegExp | null {
  // Without whole-word bounds: an escape (`\t` for a tab) puts a word
  // character where the line has none, which would fail a bound that holds.
  const matcher = buildLiteralMatcher({ ...query, wholeWord: false }, maxQueryCharacters);
  if (!matcher || JSON_ESCAPED.test(query.text.normalize('NFC'))) return null;
  return new RegExp(matcher.source, matcher.flags.replace('g', ''));
}

function searchTextOf(payload: StoredPayload | null): SearchText | null {
  const text = payload?.text;
  if (!text) return null;
  return {
    lines: text.lines,
    sourceLines: text.sourceLines,
    kinds: text.kinds,
    characters: payload.characters,
  };
}

/**
 * The persistent engine: analysis results live in a live index that
 * survives launches, so a reopened workspace reads only what changed.
 * Each document stores its Markdown (chunked and ranked by the live index)
 * and a payload with its record and the line-mapped text literal search
 * runs over, which keeps find-in-files exactly as it was.
 *
 * Runs wherever the live index's database does: a Worker owning an
 * origin-private SQLite pool, or Node in tests. The host closes the
 * database in `onDispose`.
 */
export function createLiveIndexEngine(
  live: LiveIndexLike,
  options: { readonly onDispose?: () => void } = {},
): LiveIndexEngine {
  return {
    restore() {
      const stored = new Map<WorkspacePath, StoredDocument>();
      for (const document of live.documents()) {
        const payload = decodePayload(document.payload);
        const version = tryParseFileSystemVersion(document.version);
        if (!payload || version === null) continue;
        stored.set(payload.record.path, {
          record: payload.record,
          characters: payload.characters,
          version,
          analyzer: typeof payload.analyzer === 'number' ? payload.analyzer : 1,
        });
      }
      return Promise.resolve(stored);
    },
    async analyze(identity, version, data, analyzeOptions) {
      const analyzed = await analyzeDocumentBytes(identity, data, analyzeOptions);
      const characters = analyzed.text?.characters ?? 0;
      live.upsert({
        path: identity.path,
        version,
        title: analyzed.record.title,
        // Only text that analyzed as UTF-8 is chunked; name-only documents keep their title.
        body: analyzed.text ? decoder.decode(data) : '',
        payload: encodePayload(analyzed.record, characters, analyzed.text),
      });
      return { record: analyzed.record, characters };
    },
    async reanalyze(identity, version, analyzeOptions) {
      const body = live.body?.(identity.path);
      // Nothing to rebuild from: a name-only document keeps no body.
      if (!body) return null;
      const data = encoder.encode(body);
      const analyzed = await analyzeDocumentBytes(
        identity,
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
        analyzeOptions,
      );
      const characters = analyzed.text?.characters ?? 0;
      // The same body under the same version: its passages hash as before, so
      // the vectors already stored for them stay attached.
      live.upsert({
        path: identity.path,
        version,
        title: analyzed.record.title,
        body: analyzed.text ? body : '',
        payload: encodePayload(analyzed.record, characters, analyzed.text),
      });
      return { record: analyzed.record, characters };
    },
    forget(path) {
      live.remove(path);
    },
    search(documents, query, searchOptions) {
      const screen = payloadScreen(query, searchOptions.limits?.maxQueryCharacters);
      const searchable: SearchableDocument[] = documents.map(({ record, pending }) => {
        const hasText = !pending && record.content !== 'name-only';
        let screened: SearchText | null | undefined;
        return {
          record,
          pending,
          hasText,
          // Read on demand rather than held: a large workspace's text stays on disk.
          get text(): SearchText | null {
            if (!hasText) return null;
            if (screened !== undefined) return screened;
            const bytes = live.get(record.path)?.payload;
            if (!bytes) return null;
            const raw = decoder.decode(bytes);
            if (!screen) return searchTextOf(decodePayloadText(raw));
            // Held for the rest of this search: only documents that can match keep text.
            screened = screen.test(raw) ? searchTextOf(decodePayloadText(raw)) : NO_TEXT;
            return screened;
          },
        };
      });
      return searchDocuments(searchable, query, searchOptions.checkpoint, searchOptions.limits);
    },
    find(query, findOptions = {}) {
      const { vector, text, ...rest } = findOptions;
      const hits = vector ? live.hybridSearch(query, vector, rest) : live.search(query, rest);
      const texts =
        text && live.passageTexts
          ? live.passageTexts(hits.flatMap((hit) => (hit.chunk === undefined ? [] : [hit.chunk])))
          : null;
      return hits.map(({ chunk, similarity, arms, ...hit }): WorkspacePassageHit => {
        const passage = chunk === undefined ? undefined : texts?.get(chunk);
        return {
          ...hit,
          ...(arms?.vector !== undefined || similarity !== undefined ? { meaning: true } : {}),
          ...(similarity !== undefined ? { similarity } : {}),
          ...(passage !== undefined ? { text: passage.slice(0, MAX_PASSAGE_TEXT) } : {}),
        };
      });
    },
    pendingEmbeddings: (limit) => live.pendingEmbeddings(limit),
    storeEmbeddings: (entries) => live.storeEmbeddings(entries),
    embeddingStats: () => live.embeddingStats(),
    rechunk: (limit) => live.rechunkStale(limit),
    dispose() {
      options.onDispose?.();
    },
  };
}
