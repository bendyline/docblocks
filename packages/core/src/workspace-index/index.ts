/**
 * @bendyline/docblocks/workspace-index — one shared, in-memory index of a
 * workspace's files and documents, with literal search and fuzzy matching.
 */

export { createWorkspaceIndex } from './workspace-index.js';
export {
  createMemoryEngine,
  type EngineAnalysis,
  type EngineSearchDocument,
  type EngineSearchOptions,
  type StoredDocument,
  type WorkspaceIndexEngine,
} from './engine.js';
export {
  LIVE_ENGINE_PAYLOAD_FORMAT,
  createLiveIndexEngine,
  type LiveIndexEngine,
  type LiveIndexLike,
  type LivePassageHit,
} from './live-engine.js';
export { analyzeDocumentBytes, type AnalyzedDocument, type DocumentIdentity } from './analyze.js';
export {
  buildLiteralMatcher,
  buildSnippet,
  searchDocuments,
  type SearchableDocument,
} from './search.js';
export type { SearchText } from './search-text.js';
export { fuzzyMatch, fuzzyMatchTokens, fuzzyTokens, type FuzzyMatch } from './fuzzy.js';
export {
  WORKSPACE_INDEX_LIMITS,
  WORKSPACE_SEARCH_LIMITS,
  type IndexedDocument,
  type IndexedDocumentContent,
  type IndexedDocumentIssue,
  type WorkspaceIndex,
  type WorkspaceIndexFile,
  type WorkspaceIndexFileKind,
  type WorkspaceIndexLimits,
  type WorkspaceIndexOptions,
  type WorkspaceIndexPhase,
  type WorkspaceIndexSource,
  type WorkspaceIndexStatus,
  type WorkspaceIndexTruncation,
  type WorkspaceSearchDocument,
  type WorkspaceSearchLimits,
  type WorkspaceSearchLineKind,
  type WorkspaceSearchLineMatch,
  type WorkspaceSearchQuery,
  type WorkspaceSearchRange,
  type WorkspaceSearchResult,
} from './types.js';
