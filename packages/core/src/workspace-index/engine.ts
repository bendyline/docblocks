import type { FileSystemVersion } from '../filesystem/v2.js';
import type { WorkspacePath } from '../filesystem/workspace-path.js';
import { analyzeDocumentBytes, type DocumentIdentity } from './analyze.js';
import type { SearchText } from './search-text.js';
import { searchDocuments, type Checkpoint } from './search.js';
import type {
  IndexedDocument,
  WorkspaceFindOptions,
  WorkspacePassageHit,
  WorkspaceSearchLimits,
  WorkspaceSearchQuery,
  WorkspaceSearchResult,
} from './types.js';

/** What an engine kept for a document: its record and the source version it was analyzed from. */
export interface StoredDocument {
  readonly record: IndexedDocument;
  /** Characters of searchable text held for it. */
  readonly characters: number;
  /** Version of `record.sourcePath` when it was analyzed. */
  readonly version: FileSystemVersion;
}

export interface EngineAnalysis {
  readonly record: IndexedDocument;
  /** Characters of searchable text the engine now holds for the document. */
  readonly characters: number;
}

export interface EngineSearchDocument {
  readonly record: IndexedDocument;
  /** Analysis still queued: content not searched yet. */
  readonly pending: boolean;
}

export interface EngineSearchOptions {
  readonly checkpoint: Checkpoint;
  readonly limits?: Partial<WorkspaceSearchLimits>;
  readonly signal?: AbortSignal;
}

/**
 * Where the workspace index keeps what it learned from reading documents,
 * and how it searches that. The index owns listing, change tracking and
 * scheduling; the engine owns analysis results and their text.
 *
 * The default engine keeps text in memory for the session. A persistent
 * engine keeps it across launches, possibly in another thread, and returns
 * what it kept from `restore()` so the index reads only documents whose
 * source version changed. The index owns the engine it is given and
 * disposes it with itself.
 */
export interface WorkspaceIndexEngine {
  /** What a previous session kept, by document path. Called once, before the first listing. */
  restore(): Promise<ReadonlyMap<WorkspacePath, StoredDocument>>;
  /** Analyze a document's bytes and keep what search needs. */
  analyze(
    identity: DocumentIdentity,
    version: FileSystemVersion,
    data: ArrayBuffer,
    options: { readonly maxParseBytes: number; readonly signal?: AbortSignal },
  ): Promise<EngineAnalysis>;
  /** Stop keeping a document: it is gone, or no longer searchable by content. */
  forget(path: WorkspacePath): void;
  /** Literal search over the documents the index currently lists, in path order. */
  search(
    documents: readonly EngineSearchDocument[],
    query: WorkspaceSearchQuery,
    options: EngineSearchOptions,
  ): Promise<WorkspaceSearchResult>;
  /** Settles with the store the engine opened. The memory engine has none to report. */
  readonly opened?: Promise<{
    readonly persistence: 'persistent' | 'memory';
    readonly ranks?: boolean;
  }>;
  /** Passages ranked by relevance, for an engine with a full-text index. */
  find?(
    query: string,
    options?: WorkspaceFindOptions,
  ): Promise<readonly WorkspacePassageHit[]> | readonly WorkspacePassageHit[];
  dispose(): void;
}

/**
 * The session-only engine: analysis on the calling thread, text in memory.
 * `maxCharacters` caps the text it holds, for an engine standing in for a
 * persistent one under that engine's larger index limits; past it, a
 * document is kept by name only.
 */
export function createMemoryEngine(
  options: { readonly maxCharacters?: number } = {},
): WorkspaceIndexEngine {
  const texts = new Map<WorkspacePath, SearchText>();
  const maxCharacters = options.maxCharacters ?? Number.POSITIVE_INFINITY;
  let held = 0;
  const drop = (path: WorkspacePath) => {
    held -= texts.get(path)?.characters ?? 0;
    texts.delete(path);
  };
  return {
    restore: () => Promise.resolve(new Map()),
    async analyze(identity, _version, data, analyzeOptions) {
      const analyzed = await analyzeDocumentBytes(identity, data, analyzeOptions);
      drop(identity.path);
      const characters = analyzed.text?.characters ?? 0;
      if (analyzed.text && held + characters > maxCharacters) {
        return {
          record: { ...analyzed.record, content: 'name-only', issue: 'over-budget' },
          characters: 0,
        };
      }
      if (analyzed.text) {
        texts.set(identity.path, analyzed.text);
        held += characters;
      }
      return { record: analyzed.record, characters };
    },
    forget(path) {
      drop(path);
    },
    search(documents, query, options) {
      return searchDocuments(
        documents.map(({ record, pending }) => ({
          record,
          // A record that lost its content (over budget, say) never searches stale text.
          text: pending || record.content === 'name-only' ? null : (texts.get(record.path) ?? null),
          pending,
        })),
        query,
        options.checkpoint,
        options.limits,
      );
    },
    dispose() {
      texts.clear();
      held = 0;
    },
  };
}
