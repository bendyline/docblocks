import type { FileSystemVersion } from '../filesystem/v2.js';
import type { WorkspacePath } from '../filesystem/workspace-path.js';
import { analyzeDocumentBytes, type DocumentIdentity } from './analyze.js';
import type { SearchText } from './search-text.js';
import { searchDocuments, type Checkpoint } from './search.js';
import type {
  IndexedDocument,
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
  dispose(): void;
}

/** The session-only engine: analysis on the calling thread, text in memory. */
export function createMemoryEngine(): WorkspaceIndexEngine {
  const texts = new Map<WorkspacePath, SearchText>();
  return {
    restore: () => Promise.resolve(new Map()),
    async analyze(identity, _version, data, options) {
      const analyzed = await analyzeDocumentBytes(identity, data, options);
      if (analyzed.text) texts.set(identity.path, analyzed.text);
      else texts.delete(identity.path);
      return { record: analyzed.record, characters: analyzed.text?.characters ?? 0 };
    },
    forget(path) {
      texts.delete(path);
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
    },
  };
}
