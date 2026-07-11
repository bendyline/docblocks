import { getFileSystemProviderV2, type FileSystemProvider } from '../filesystem/types.js';
import { FsError } from '../filesystem/fs-error.js';
import { parseWorkspacePath } from '../filesystem/workspace-path.js';
import { DocumentCommitConflictError } from './document-session.js';
import type { DocumentCommitTarget, DocumentExternalVersion } from './types.js';

export interface FileSystemDocumentTargetOptions {
  /**
   * Compare the current file with the session's persisted baseline before
   * replacing it. Enabled by default.
   */
  verifyExternalChanges?: boolean;
  onCommitted?: (content: string, revision: number) => void;
}

/**
 * Adapt a FileSystemProvider path to the commit protocol used by
 * DocumentSession. The optimistic read catches external edits/deletions
 * before a local write recreates or silently replaces them.
 */
export function createFileSystemDocumentTarget(
  provider: FileSystemProvider,
  path: string,
  options: FileSystemDocumentTargetOptions = {},
): DocumentCommitTarget {
  const verifyExternalChanges = options.verifyExternalChanges ?? true;
  const canonicalPath = parseWorkspacePath(path);
  const providerV2 = getFileSystemProviderV2(provider);
  return {
    key: provider.id + ':' + canonicalPath,
    async commit(request) {
      if (providerV2 && providerV2.capabilities.conditionalWrite !== 'none') {
        const current = await providerV2.readFile(canonicalPath);
        const currentContent = current ? new TextDecoder().decode(current.data) : null;
        if (currentContent !== request.persistedContent && currentContent !== request.content) {
          throw new DocumentCommitConflictError(
            'The document changed outside DocBlocks: ' + path,
            currentContent,
            current?.entry.version ?? null,
          );
        }
        if (currentContent === request.content) {
          options.onCommitted?.(request.content, request.revision);
          return { version: current?.entry.version ?? null };
        }

        try {
          const committed = await providerV2.writeFile(
            canonicalPath,
            new TextEncoder().encode(request.content),
            {
              mode: current ? 'replace' : 'create',
              createParents: true,
              expectedVersion: current?.entry.version ?? null,
            },
          );
          options.onCommitted?.(request.content, request.revision);
          return { version: committed.version };
        } catch (error: unknown) {
          if (
            error instanceof FsError &&
            (error.code === 'conflict' ||
              error.code === 'already-exists' ||
              error.code === 'not-found')
          ) {
            const external = await providerV2.readFile(canonicalPath);
            throw new DocumentCommitConflictError(
              'The document changed outside DocBlocks: ' + path,
              external ? new TextDecoder().decode(external.data) : null,
              external?.entry.version ?? null,
            );
          }
          throw error;
        }
      }

      if (provider.commitFile) {
        const result = await provider.commitFile(path, request.content, request.persistedContent);
        if (result.status === 'conflict') {
          throw new DocumentCommitConflictError(
            'The document changed outside DocBlocks: ' + path,
            result.content,
            result.version,
          );
        }
        options.onCommitted?.(request.content, request.revision);
        return { version: result.version };
      }

      if (verifyExternalChanges) {
        const current = await provider.readFile(path);
        if (current !== request.persistedContent && current !== request.content) {
          const meta = await provider.stat(path).catch(() => null);
          const version: DocumentExternalVersion = meta?.lastModified ?? null;
          throw new DocumentCommitConflictError(
            'The document changed outside DocBlocks: ' + path,
            current,
            version,
          );
        }
      }

      await provider.writeFile(path, request.content);
      options.onCommitted?.(request.content, request.revision);
      const meta = await provider.stat(path).catch(() => null);
      return { version: meta?.lastModified ?? null };
    },
  };
}
