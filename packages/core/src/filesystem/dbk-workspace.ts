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
   * rebases non-document files beneath `<document>_files/`. `auto` preserves
   * a DBK whose primary path already matches the target, otherwise rebasing
   * imported media into the companion directory.
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
  if (path.includes('\\') || path.includes('\0')) {
    throw new Error(`DBK ${label} must use a safe forward-slash path: ${path}`);
  }
  const normalized = path.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
  const segments = normalized ? normalized.split('/') : [];
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`DBK ${label} must not be empty or traverse directories: ${path}`);
  }
  return segments.join('/');
}

function joinPath(parent: string, child: string): string {
  return `${parent.replace(/\/+$/g, '')}/${child.replace(/^\/+/, '')}`;
}

/**
 * Fully materialize and validate a DBK container before touching its target
 * provider. A missing or unreadable entry fails the snapshot as a whole.
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
  const files: MemoryFileSystemSnapshotFile[] = [];
  let documentContent: string | null = null;

  for (const entry of entries) {
    const sourcePath = normaliseRelativePath(entry.path, 'entry path');
    if (seenSourcePaths.has(sourcePath)) {
      throw new Error(`The external DBK contains duplicate paths: ${sourcePath}`);
    }
    seenSourcePaths.add(sourcePath);

    const data = await source.readFile(entry.path);
    if (data === null) {
      throw new Error(`The external DBK changed while reading: ${sourcePath}`);
    }
    if (sourcePath === sourceDocumentPath) {
      documentContent = new TextDecoder().decode(data);
      files.push({ kind: 'text', path: targetDocumentPath, content: documentContent });
      continue;
    }

    const targetPath =
      assetLayout === 'preserve' ? sourcePath : joinPath(companionPath, sourcePath);
    if (/\.(?:md|mdx|txt)$/i.test(sourcePath)) {
      files.push({ kind: 'text', path: targetPath, content: new TextDecoder().decode(data) });
    } else {
      files.push({ kind: 'binary', path: targetPath, data });
    }
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
