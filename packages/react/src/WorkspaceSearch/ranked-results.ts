import type {
  IndexedDocument,
  WorkspacePassageHit,
  WorkspaceSearchDocument,
  WorkspaceSearchResult,
} from '@bendyline/docblocks/workspace-index';

/** Passages asked for in ranked mode; three per document at most. */
export const RANKED_PASSAGE_LIMIT = 60;
export const RANKED_PASSAGES_PER_DOCUMENT = 3;

/**
 * Ranked passages in the shape literal results use, so the panel lists them
 * the same way: documents in order of their best passage, each passage a
 * row at its first line with its matched words highlighted.
 */
export function rankedSearchResult(
  hits: readonly WorkspacePassageHit[],
  documentOf: (path: string) => IndexedDocument | null,
): WorkspaceSearchResult {
  const groups = new Map<string, WorkspacePassageHit[]>();
  for (const hit of hits) {
    const group = groups.get(hit.path);
    if (group) group.push(hit);
    else groups.set(hit.path, [hit]);
  }
  const documents: WorkspaceSearchDocument[] = [...groups].map(([path, passages]) => {
    const record = documentOf(path);
    return {
      path: record?.path ?? (path as WorkspaceSearchDocument['path']),
      title: passages[0]?.title || record?.title || path,
      format: record?.format ?? 'markdown',
      titleMatch: false,
      titleRanges: [],
      matchCount: passages.length,
      matches: passages.map((passage) => ({
        line: passage.lineStart,
        kind:
          passage.headingPath.length > 0 && passage.lineStart === passage.lineEnd
            ? 'heading'
            : 'text',
        snippet: passage.snippet,
        ranges: passage.ranges,
        occurrence: 0,
      })),
      moreMatches: false,
      lastModified: record?.lastModified ?? '',
      pending: false,
    };
  });
  return {
    documents,
    totalDocuments: documents.length,
    totalMatches: hits.length,
    truncated: hits.length >= RANKED_PASSAGE_LIMIT,
    pendingDocuments: 0,
    skippedDocuments: 0,
  };
}

/** The word a ranked passage matched, for Find to land on; the query's first word otherwise. */
export function matchedWord(
  match: {
    readonly snippet: string;
    readonly ranges: readonly (readonly [number, number])[];
  } | null,
  query: string,
): string {
  const range = match?.ranges[0];
  if (match && range) return match.snippet.slice(range[0], range[1]);
  return /[\p{L}\p{N}_]+/u.exec(query)?.[0] ?? query;
}
