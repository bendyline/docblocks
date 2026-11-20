import type { FindRequest } from '@bendyline/squisq-editor-react';
import type { WorkspaceSearchOpenRequest } from './WorkspaceSearchPanel.js';

/**
 * What the editor's Find bar should show when a workspace search result is
 * opened: the same query and options, on the chosen line's first match.
 * Opening a document row lands on its first match. Kept apart from the
 * panel so the shell can use it without loading the lazy panel chunk.
 */
export function findRequestForSearchOpen(open: WorkspaceSearchOpenRequest): FindRequest | null {
  // The index matches the query as typed, spaces included, so Find must too.
  if (!open.query.trim()) return null;
  return {
    query: open.query,
    matchCase: open.matchCase,
    wholeWord: open.wholeWord,
    occurrence: open.match?.occurrence ?? 0,
  };
}
