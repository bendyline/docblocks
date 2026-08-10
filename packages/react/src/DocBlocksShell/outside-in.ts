import {
  FileSystemContentContainer,
  FsError,
  getFileSystemProviderV2,
  parseWorkspacePath,
  type FileSystemProvider,
} from '@bendyline/docblocks/filesystem';
import {
  createFileSystemDocumentTarget,
  type DocumentCommitTarget,
} from '@bendyline/docblocks/document';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { providerEntryExists, writeProviderText } from './provider-io.js';
import {
  chooseOutsideInMarkdownPath,
  importOutsideInDocument,
  readOutsideInMetadata,
  renderOutsideInDocument,
  resolveOutsideInLayout,
  withOutsideInMetadata,
  type OutsideInLayout,
} from './outside-in-contract.js';

export type { OutsideInLayout } from './outside-in-contract.js';
export { resolveOutsideInLayout, withOutsideInMetadata } from './outside-in-contract.js';

const OUTSIDE_IN_EXTENSION = /\.(?:html?|docx|pdf|pptx|xlsx)$/i;
const SQUISQ_RUNTIME_DIRECTORY = '_squisq';
const SQUISQ_RUNTIME_FILENAME = 'squisq-player.js';

export interface EditableShellDocument {
  /** User-facing file selected in the explorer. */
  displayPath: string;
  /** Markdown file observed and committed by DocumentSession. */
  sourcePath: string;
  content: string;
  outsideIn: OutsideInLayout | null;
}

function withoutLeadingSlash(path: string): string {
  return parseWorkspacePath(path);
}

function withLegacySlash(path: string, like: string): string {
  const canonical = withoutLeadingSlash(path);
  return like.startsWith('/') && canonical ? `/${canonical}` : canonical;
}

function dirname(path: string): string {
  const canonical = withoutLeadingSlash(path);
  const slash = canonical.lastIndexOf('/');
  return slash < 0 ? '' : canonical.slice(0, slash);
}

function join(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function relativePath(fromDirectory: string, targetPath: string): string {
  const from = withoutLeadingSlash(fromDirectory).split('/').filter(Boolean);
  const target = withoutLeadingSlash(targetPath).split('/').filter(Boolean);
  let shared = 0;
  while (shared < from.length && shared < target.length && from[shared] === target[shared]) {
    shared++;
  }
  const segments = [...from.slice(shared).map(() => '..'), ...target.slice(shared)];
  return segments.join('/') || '.';
}

async function readText(provider: FileSystemProvider, path: string): Promise<string | null> {
  const v2 = getFileSystemProviderV2(provider);
  if (!v2) return provider.readFile(path);
  const current = await v2.readFile(parseWorkspacePath(path));
  if (!current) return null;
  return new TextDecoder('utf-8', { fatal: true }).decode(current.data);
}

async function readBytes(provider: FileSystemProvider, path: string): Promise<ArrayBuffer | null> {
  const v2 = getFileSystemProviderV2(provider);
  if (v2) return (await v2.readFile(parseWorkspacePath(path)))?.data ?? null;
  return provider.readBinary(path);
}

async function writeBytes(
  provider: FileSystemProvider,
  path: string,
  data: ArrayBuffer | Uint8Array,
  mode: 'create' | 'upsert' = 'upsert',
): Promise<void> {
  const v2 = getFileSystemProviderV2(provider);
  if (v2) {
    await v2.writeFile(parseWorkspacePath(path), data, {
      mode,
      createParents: true,
      expectedVersion: mode === 'create' ? null : undefined,
    });
    return;
  }
  if (mode === 'create' && (await provider.exists(path))) {
    throw new FsError('already-exists', 'File already exists.', { operation: 'write', path });
  }
  await provider.writeBinary(path, data);
}

async function listCompanionFiles(
  provider: FileSystemProvider,
  layout: OutsideInLayout,
): Promise<string[]> {
  try {
    const entries = await provider.readDirectory(layout.companionDirectory);
    return entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path);
  } catch (error: unknown) {
    if (error instanceof FsError && error.code === 'not-found') return [];
    throw error;
  }
}

/** Remove the complete hidden editable representation after its visible target is deleted. */
export async function removeOutsideInCompanion(
  provider: FileSystemProvider,
  layout: OutsideInLayout,
): Promise<void> {
  const providerV2 = getFileSystemProviderV2(provider);
  if (providerV2) {
    const path = parseWorkspacePath(layout.companionDirectory);
    if ((await providerV2.stat(path)) !== null) {
      await providerV2.remove(path, { recursive: true, missing: 'ignore' });
    }
    return;
  }
  if (await provider.exists(layout.companionDirectory)) {
    await provider.delete(layout.companionDirectory);
  }
}

async function persistImportedMedia(
  provider: FileSystemProvider,
  layout: OutsideInLayout,
  container: ContentContainer,
): Promise<void> {
  const entries = await container.listFiles();
  for (const entry of entries) {
    if (/\.md$/i.test(entry.path)) continue;
    const data = await container.readFile(entry.path);
    if (!data) continue;
    await writeBytes(provider, join(layout.companionDirectory, entry.path), data, 'create');
  }
}

/**
 * Load a selected workspace file as the Markdown snapshot the editor should
 * mount. Supported rendered formats are imported once and then reopen their
 * durable companion Markdown.
 */
export async function loadEditableShellDocument(
  provider: FileSystemProvider,
  selectedPath: string,
): Promise<EditableShellDocument | null> {
  if (!OUTSIDE_IN_EXTENSION.test(selectedPath)) {
    const content = await readText(provider, selectedPath);
    return content === null
      ? null
      : {
          displayPath: selectedPath,
          sourcePath: selectedPath,
          content,
          outsideIn: null,
        };
  }

  const resolved = resolveOutsideInLayout(selectedPath);
  if (!resolved) return null;
  const layout: OutsideInLayout = {
    ...resolved,
    targetPath: withLegacySlash(resolved.targetPath, selectedPath),
    companionDirectory: withLegacySlash(resolved.companionDirectory, selectedPath),
    markdownPath: withLegacySlash(resolved.markdownPath, selectedPath),
  };

  const candidates = (await listCompanionFiles(provider, layout)).map((path) =>
    withLegacySlash(path, selectedPath),
  );
  const chosen = chooseOutsideInMarkdownPath(layout, candidates);
  if (chosen) {
    const content = await readText(provider, chosen);
    if (content === null) return null;
    const metadata = await readOutsideInMetadata(content);
    if (metadata && metadata.format !== layout.format) {
      throw new Error(
        `${chosen} is configured for ${metadata.format}, not ${layout.format}. ` +
          'Rename the rendered file back or repair the companion frontmatter.',
      );
    }
    const linkedContent = await withOutsideInMetadata(content, layout);
    if (linkedContent !== content) await writeProviderText(provider, chosen, linkedContent);
    return {
      displayPath: selectedPath,
      sourcePath: chosen,
      content: linkedContent,
      outsideIn: { ...layout, markdownPath: chosen },
    };
  }

  const rendered = await readBytes(provider, selectedPath);
  if (!rendered) return null;
  const imported = await importOutsideInDocument({
    data: rendered,
    targetPath: selectedPath,
  });
  const importedLayout: OutsideInLayout = {
    ...imported.layout,
    targetPath: withLegacySlash(imported.layout.targetPath, selectedPath),
    companionDirectory: withLegacySlash(imported.layout.companionDirectory, selectedPath),
    markdownPath: withLegacySlash(imported.layout.markdownPath, selectedPath),
  };
  await persistImportedMedia(provider, importedLayout, imported.container);
  await writeProviderText(provider, importedLayout.markdownPath, imported.markdown, 'create');
  return {
    displayPath: selectedPath,
    sourcePath: importedLayout.markdownPath,
    content: imported.markdown,
    outsideIn: importedLayout,
  };
}

async function findRuntimePath(provider: FileSystemProvider, targetPath: string): Promise<string> {
  let directory = dirname(targetPath);
  for (;;) {
    const candidateDirectory = join(directory, SQUISQ_RUNTIME_DIRECTORY);
    if (await providerEntryExists(provider, candidateDirectory)) {
      const providerV2 = getFileSystemProviderV2(provider);
      if (providerV2) {
        const entry = await providerV2.stat(parseWorkspacePath(candidateDirectory));
        if (entry?.kind !== 'directory') {
          throw new Error(`${candidateDirectory} must be a directory.`);
        }
      }
      return join(candidateDirectory, SQUISQ_RUNTIME_FILENAME);
    }
    if (!directory) break;
    directory = dirname(directory);
  }
  return join(SQUISQ_RUNTIME_DIRECTORY, SQUISQ_RUNTIME_FILENAME);
}

async function writeRuntimeIfNeeded(
  provider: FileSystemProvider,
  runtimePath: string,
): Promise<void> {
  const { PLAYER_BUNDLE } = await import('@bendyline/squisq-react/standalone-source');
  const current = await readText(provider, runtimePath);
  if (current !== PLAYER_BUNDLE) await writeProviderText(provider, runtimePath, PLAYER_BUNDLE);
}

/**
 * Commit target that persists the Markdown source and then regenerates its
 * user-facing format. Conversion completes before either durable write; a
 * later output failure remains visible as a dirty DocumentSession revision
 * and a retry safely finishes the derived write.
 */
export function createOutsideInDocumentTarget(
  provider: FileSystemProvider,
  layout: OutsideInLayout,
  onCommitted?: () => void,
): DocumentCommitTarget {
  const sourceTarget = createFileSystemDocumentTarget(provider, layout.markdownPath);
  return {
    key: `${provider.id}:outside-in:${parseWorkspacePath(layout.targetPath)}`,
    async commit(request) {
      const runtimePath =
        layout.format === 'html' ? await findRuntimePath(provider, layout.targetPath) : null;
      const outputDirectory = dirname(layout.targetPath);
      const rendered = await renderOutsideInDocument(
        {
          markdown: request.content,
          targetPath: layout.targetPath,
          container: new FileSystemContentContainer(provider, layout.companionDirectory),
        },
        runtimePath
          ? {
              html: {
                playerScriptPath: relativePath(outputDirectory, runtimePath),
                basePath: relativePath(outputDirectory, layout.companionDirectory),
              },
            }
          : {},
      );

      await sourceTarget.commit({ ...request, targetKey: sourceTarget.key });
      if (runtimePath) await writeRuntimeIfNeeded(provider, runtimePath);
      await writeBytes(provider, layout.targetPath, rendered.bytes);
      onCommitted?.();
      return {};
    },
  };
}

/** Companion-root container used for media, history, and exports. */
export function createOutsideInContentContainer(
  provider: FileSystemProvider,
  layout: OutsideInLayout,
): ContentContainer {
  return new FileSystemContentContainer(provider, layout.companionDirectory);
}
