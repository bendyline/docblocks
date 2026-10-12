import { useCallback } from 'react';
import type { DocumentLinkProvider } from '@bendyline/squisq-editor-react';
import type { WorkspaceIndex } from '@bendyline/docblocks/workspace-index';
import { createDocumentLinkCandidates } from './document-links.js';

/** How long the link picker waits for a first listing before offering what it has. */
const LISTING_WAIT_MS = 5_000;

/**
 * Link-picker suggestions from the shared workspace index. The index keeps
 * itself current from change events and commits, so documents created or
 * renamed since the dialog last opened are always offered.
 */
export function useDocumentLinkProvider(
  index: WorkspaceIndex | null,
  selectedFile: string | null,
  ensureIndex: () => void,
): DocumentLinkProvider {
  return useCallback<DocumentLinkProvider>(
    async (query) => {
      if (!index || !selectedFile) return [];
      ensureIndex();
      await index.whenListed({ timeoutMs: LISTING_WAIT_MS });
      const documents = index.getFiles().filter((file) => file.kind === 'markdown');
      return createDocumentLinkCandidates(documents, selectedFile, query);
    },
    [index, selectedFile, ensureIndex],
  );
}
