import { useCallback, useEffect, useRef } from 'react';
import type { DocumentLinkProvider } from '@bendyline/squisq-editor-react';
import type { FileSystemEntry, FileSystemProvider } from '@bendyline/docblocks/filesystem';
import { collectMarkdownFiles, createDocumentLinkCandidates } from './document-links.js';

interface DocumentLinkCache {
  readonly provider: FileSystemProvider;
  readonly epoch: number;
  readonly controller: AbortController;
  readonly entries: Promise<FileSystemEntry[]>;
}

export function useDocumentLinkProvider(
  provider: FileSystemProvider | null,
  selectedFile: string | null,
  epoch = 0,
): DocumentLinkProvider {
  const cacheRef = useRef<DocumentLinkCache | null>(null);

  useEffect(
    () => () => {
      if (cacheRef.current?.provider !== provider || cacheRef.current.epoch !== epoch) return;
      cacheRef.current.controller.abort();
      cacheRef.current = null;
    },
    [provider, epoch],
  );

  return useCallback<DocumentLinkProvider>(
    async (query) => {
      if (!provider || !selectedFile) return [];
      let cache = cacheRef.current;
      if (!cache || cache.provider !== provider || cache.epoch !== epoch) {
        cache?.controller.abort();
        const controller = new AbortController();
        cache = {
          provider,
          epoch,
          controller,
          entries: collectMarkdownFiles(provider, '', { signal: controller.signal }),
        };
        cacheRef.current = cache;
      }
      try {
        return createDocumentLinkCandidates(await cache.entries, selectedFile, query);
      } catch (error: unknown) {
        if (cacheRef.current === cache) cacheRef.current = null;
        throw error;
      }
    },
    [provider, selectedFile, epoch],
  );
}
