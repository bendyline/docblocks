/**
 * @bendyline/docblocks/workspace-index — one shared, in-memory index of a
 * workspace's files and documents, with literal search and fuzzy matching.
 */

export { createWorkspaceIndex } from './workspace-index.js';
export { buildLiteralMatcher, buildSnippet } from './search.js';
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
