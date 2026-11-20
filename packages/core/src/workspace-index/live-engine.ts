import { tryParseFileSystemVersion } from '../filesystem/v2.js';
import type { WorkspacePath } from '../filesystem/workspace-path.js';
import { analyzeDocumentBytes } from './analyze.js';
import type { StoredDocument, WorkspaceIndexEngine } from './engine.js';
import type { SearchText } from './search-text.js';
import { searchDocuments, type SearchableDocument } from './search.js';
import type { IndexedDocument, WorkspaceSearchLineKind } from './types.js';

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
  documents(batchSize?: number): Iterable<{
    readonly path: string;
    readonly version: string;
    readonly payload: Uint8Array | null;
  }>;
  search(
    query: string,
    options?: {
      readonly limit?: number;
      readonly perDocument?: number;
      readonly prefix?: boolean;
      readonly exclude?: ReadonlySet<string>;
    },
  ): readonly LivePassageHit[];
}

/** A ranked passage, as the live index reports it. */
export interface LivePassageHit {
  readonly path: string;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly snippet: string;
  readonly ranges: ReadonlyArray<readonly [number, number]>;
  readonly score: number;
}

export interface LiveIndexEngine extends WorkspaceIndexEngine {
  /** Best-matching passages by BM25 over titles, headings and text. */
  find(query: string, options?: Parameters<LiveIndexLike['search']>[1]): readonly LivePassageHit[];
}

/**
 * Bumped when the stored payload changes shape; the host passes it as part
 * of the live index's `appVersion`, so an older index starts empty.
 */
export const LIVE_ENGINE_PAYLOAD_FORMAT = 1;

interface StoredPayload {
  readonly format: typeof LIVE_ENGINE_PAYLOAD_FORMAT;
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
    record,
    characters,
    text: text ? { lines: text.lines, sourceLines: text.sourceLines, kinds: text.kinds } : null,
  };
  return encoder.encode(JSON.stringify(payload));
}

/** A stored payload, or null when it is missing or not one this engine wrote. */
function decodePayload(bytes: Uint8Array | null | undefined): StoredPayload | null {
  if (!bytes) return null;
  try {
    const value = JSON.parse(decoder.decode(bytes)) as Partial<StoredPayload>;
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
    forget(path) {
      live.remove(path);
    },
    search(documents, query, searchOptions) {
      const searchable: SearchableDocument[] = documents.map(({ record, pending }) => ({
        record,
        pending,
        // Read on demand rather than held: a large workspace's text stays on disk.
        get text(): SearchText | null {
          if (pending || record.content === 'name-only') return null;
          return searchTextOf(decodePayload(live.get(record.path)?.payload));
        },
      }));
      return searchDocuments(searchable, query, searchOptions.checkpoint, searchOptions.limits);
    },
    find(query, findOptions) {
      return live.search(query, findOptions);
    },
    dispose() {
      options.onDispose?.();
    },
  };
}
