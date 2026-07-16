import type { ContentContainer } from '@bendyline/squisq/storage';
import { documentCompanionPath } from './move-entry.js';
import type {
  MemoryFileSystemProvider,
  MemoryFileSystemSnapshot,
  MemoryFileSystemSnapshotFile,
} from './memory-provider.js';

export type DbkWorkspaceAssetLayout = 'auto' | 'preserve' | 'companion';

export interface DbkWorkspaceSnapshotOptions {
  /** Provider-relative path of the transient workspace's active markdown file. */
  targetDocumentPath: string;
  /**
   * `preserve` treats the DBK as a serialized workspace tree. `companion`
   * rebases secondary Markdown files beneath `<document>_files/`. `auto`
   * preserves a DBK whose primary path already matches the target, otherwise
   * rebasing the secondary documents into the companion directory.
   */
  assetLayout?: DbkWorkspaceAssetLayout;
}

export interface DbkWorkspaceSnapshot extends MemoryFileSystemSnapshot {
  readonly sourceDocumentPath: string;
  readonly targetDocumentPath: string;
  readonly documentContent: string;
  readonly assetLayout: Exclude<DbkWorkspaceAssetLayout, 'auto'>;
}

function normaliseRelativePath(path: string, label: string): string {
  if (
    path.includes('\\') ||
    /^[a-zA-Z]:/u.test(path) ||
    [...path].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error(`DBK ${label} must use a safe forward-slash path: ${path}`);
  }
  const normalized = path.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
  const segments = normalized ? normalized.split('/') : [];
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`DBK ${label} must not be empty or traverse directories: ${path}`);
  }
  return segments.join('/');
}

function decodeMarkdownFile(data: ArrayBuffer, path: string): string {
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new Error(`The external DBK contains invalid UTF-8 Markdown: ${path}`);
  }
  if (content.includes('\0')) {
    throw new Error(`The external DBK contains a NUL character in Markdown: ${path}`);
  }
  return content;
}

function joinPath(parent: string, child: string): string {
  return `${parent.replace(/\/+$/g, '')}/${child.replace(/^\/+/, '')}`;
}

/**
 * Fully materialize and validate a DBK container before touching its target
 * provider. Transient workspace DBKs are intentionally Markdown-only: every
 * member must be a valid UTF-8 `.md` file. A missing, unreadable, binary, or
 * differently typed entry fails the snapshot as a whole.
 */
export async function createDbkWorkspaceSnapshot(
  source: ContentContainer,
  options: DbkWorkspaceSnapshotOptions,
): Promise<DbkWorkspaceSnapshot> {
  const targetDocumentPath = normaliseRelativePath(
    options.targetDocumentPath,
    'target document path',
  );
  const discoveredDocumentPath = await source.getDocumentPath();
  if (!discoveredDocumentPath)
    throw new Error('The external DBK has no primary markdown document.');
  const sourceDocumentPath = normaliseRelativePath(discoveredDocumentPath, 'primary document path');
  const requestedLayout = options.assetLayout ?? 'auto';
  const assetLayout: Exclude<DbkWorkspaceAssetLayout, 'auto'> =
    requestedLayout === 'auto'
      ? sourceDocumentPath === targetDocumentPath
        ? 'preserve'
        : 'companion'
      : requestedLayout;
  const companionPath = normaliseRelativePath(
    documentCompanionPath(targetDocumentPath),
    'companion directory path',
  );

  const listed = await source.listFiles();
  const entries = [...listed].sort((a, b) => a.path.localeCompare(b.path));
  const seenSourcePaths = new Set<string>();
  const validatedEntries: Array<{ sourcePath: string; containerPath: string }> = [];
  const files: MemoryFileSystemSnapshotFile[] = [];
  let documentContent: string | null = null;

  for (const entry of entries) {
    const sourcePath = normaliseRelativePath(entry.path, 'entry path');
    if (seenSourcePaths.has(sourcePath)) {
      throw new Error(`The external DBK contains duplicate paths: ${sourcePath}`);
    }
    seenSourcePaths.add(sourcePath);
    if (!/\.md$/iu.test(sourcePath)) {
      throw new Error(
        `The external DBK is corrupt: only Markdown (.md) files are allowed (${sourcePath}).`,
      );
    }
    validatedEntries.push({ sourcePath, containerPath: entry.path });
  }

  for (const entry of validatedEntries) {
    const { sourcePath } = entry;
    const data = await source.readFile(entry.containerPath);
    if (data === null) {
      throw new Error(`The external DBK changed while reading: ${sourcePath}`);
    }
    const content = decodeMarkdownFile(data, sourcePath);
    if (sourcePath === sourceDocumentPath) {
      documentContent = content;
      files.push({ kind: 'text', path: targetDocumentPath, content: documentContent });
      continue;
    }

    const targetPath =
      assetLayout === 'preserve' ? sourcePath : joinPath(companionPath, sourcePath);
    files.push({ kind: 'text', path: targetPath, content });
  }

  if (documentContent === null) {
    throw new Error(`The external DBK did not include its primary document: ${sourceDocumentPath}`);
  }

  return {
    sourceDocumentPath,
    targetDocumentPath,
    documentContent,
    assetLayout,
    files,
  };
}

/**
 * Replace a transient DBK workspace as one logical operation.
 *
 * Container reads and validation happen before provider mutation. The memory
 * provider then stages and swaps the full tree synchronously, which removes
 * stale files and guarantees the old tree survives any failed replacement.
 */
export async function replaceMemoryWorkspaceFromDbk(
  provider: MemoryFileSystemProvider,
  source: ContentContainer,
  options: DbkWorkspaceSnapshotOptions,
): Promise<DbkWorkspaceSnapshot> {
  const expectedTreeVersion = provider.treeVersion;
  const snapshot = await createDbkWorkspaceSnapshot(source, options);
  provider.replaceContents(snapshot, expectedTreeVersion);
  return snapshot;
}
