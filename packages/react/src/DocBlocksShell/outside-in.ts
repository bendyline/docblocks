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
  isOutsideInMarkdownEditingEnabled,
  readOutsideInHtmlOutput,
  readOutsideInMetadata,
  renderOutsideInDocument,
  resolveOutsideInLayout,
  withOutsideInHtmlOutput,
  withOutsideInMarkdownEditing,
  withOutsideInMetadata,
  type OutsideInLayout,
  type OutsideInHtmlOutput,
} from './outside-in-contract.js';

export type { OutsideInLayout } from './outside-in-contract.js';
export { resolveOutsideInLayout, withOutsideInMetadata } from './outside-in-contract.js';

const OUTSIDE_IN_EXTENSION = /\.(?:html?|docx|pdf|pptx|xlsx|csv)$/i;
const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};
const SQUISQ_RUNTIME_DIRECTORY = '_squisq';
const SQUISQ_RUNTIME_FILENAME = 'squisq-player.js';

export interface EditableShellDocument {
  /** User-facing file selected in the explorer. */
  displayPath: string;
  /** Markdown file observed and committed by DocumentSession. */
  sourcePath: string;
  content: string;
  outsideIn: OutsideInLayout | null;
  /** Whether edits may regenerate an outside-in rendered target. */
  outsideInEditingEnabled: boolean;
  /** Binary image payload rendered through Squisq's image-viewer mode. */
  image?: { data: ArrayBuffer; mimeType: string };
}

export interface EditableOutsideInDocument extends EditableShellDocument {
  outsideIn: OutsideInLayout;
  outsideInEditingEnabled: true;
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
  const imageExtension = selectedPath.slice(selectedPath.lastIndexOf('.') + 1).toLowerCase();
  const imageMimeType = IMAGE_MIME_TYPES[imageExtension];
  if (imageMimeType) {
    const data = await readBytes(provider, selectedPath);
    return data === null
      ? null
      : {
          displayPath: selectedPath,
          sourcePath: selectedPath,
          content: '',
          outsideIn: null,
          outsideInEditingEnabled: false,
          image: { data, mimeType: imageMimeType },
        };
  }

  if (!OUTSIDE_IN_EXTENSION.test(selectedPath)) {
    const content = await readText(provider, selectedPath);
    return content === null
      ? null
      : {
          displayPath: selectedPath,
          sourcePath: selectedPath,
          content,
          outsideIn: null,
          outsideInEditingEnabled: true,
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
      outsideInEditingEnabled: await isOutsideInMarkdownEditingEnabled(linkedContent),
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
    outsideInEditingEnabled: false,
  };
}

/**
 * Preserve the original rendered bytes, then explicitly authorize Markdown-
 * driven regeneration. The create-only backup is never replaced by a later
 * opt-in, so it remains a stable restoration point.
 */
export async function enableOutsideInMarkdownEditing(
  provider: FileSystemProvider,
  document: EditableShellDocument,
): Promise<EditableOutsideInDocument> {
  const layout = document.outsideIn;
  if (!layout) throw new Error('This file does not support outside-in Markdown editing.');

  const original = await readBytes(provider, layout.targetPath);
  if (!original) throw new Error(`The rendered file "${layout.targetPath}" was not found.`);
  try {
    await writeBytes(provider, layout.backupPath, original, 'create');
  } catch (error: unknown) {
    if (!(error instanceof FsError && error.code === 'already-exists')) throw error;
  }

  const content = await withOutsideInMarkdownEditing(document.content, layout);
  if (content !== document.content) await writeProviderText(provider, document.sourcePath, content);
  return { ...document, content, outsideIn: layout, outsideInEditingEnabled: true };
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

async function renderPlainOutsideInHtml(
  provider: FileSystemProvider,
  layout: OutsideInLayout,
  markdown: string,
): Promise<Uint8Array> {
  const [{ parseMarkdown }, { markdownDocToPlainHtml }] = await Promise.all([
    import('@bendyline/squisq/markdown'),
    import('@bendyline/squisq-formats/html'),
  ]);
  const container = new FileSystemContentContainer(provider, layout.companionDirectory);
  const images = new Map<string, string>();
  for (const entry of await container.listFiles()) {
    const outputPath = `${layout.companionName}/${entry.path}`;
    images.set(entry.path, outputPath);
    images.set(`./${entry.path}`, outputPath);
  }
  return new TextEncoder().encode(
    markdownDocToPlainHtml(parseMarkdown(markdown), {
      title: layout.stem,
      images: images.size > 0 ? images : undefined,
    }),
  );
}

interface PreparedOutsideInRender {
  bytes: Uint8Array;
  runtimePath: string | null;
}

async function prepareOutsideInRender(
  provider: FileSystemProvider,
  layout: OutsideInLayout,
  markdown: string,
): Promise<PreparedOutsideInRender> {
  const htmlOutput = layout.format === 'html' ? await readOutsideInHtmlOutput(markdown) : null;
  if (htmlOutput === 'static') {
    return {
      bytes: await renderPlainOutsideInHtml(provider, layout, markdown),
      runtimePath: null,
    };
  }

  const runtimePath =
    layout.format === 'html' ? await findRuntimePath(provider, layout.targetPath) : null;
  const outputDirectory = dirname(layout.targetPath);
  const rendered = await renderOutsideInDocument(
    {
      markdown,
      targetPath: layout.targetPath,
      container: new FileSystemContentContainer(provider, layout.companionDirectory),
    },
    runtimePath
      ? {
          html: {
            playerScriptPath: relativePath(outputDirectory, runtimePath),
            basePath: relativePath(outputDirectory, layout.companionDirectory),
          },
          ...(htmlOutput === 'interactive'
            ? { formatOptions: { html: { mode: 'slideshow' as const } } }
            : {}),
        }
      : {},
  );
  return { bytes: rendered.bytes, runtimePath };
}

/**
 * Create a rendered outside-in document from a fresh Markdown source. New
 * documents opt into regeneration immediately because there is no imported
 * original to preserve or ask permission to replace.
 */
export async function createNewOutsideInDocument(
  provider: FileSystemProvider,
  targetPath: string,
  htmlOutput?: OutsideInHtmlOutput,
): Promise<EditableOutsideInDocument> {
  const layout = resolveOutsideInLayout(targetPath);
  if (!layout) throw new Error(`Outside-in editing does not support "${targetPath}".`);
  if (layout.format !== 'html' && htmlOutput !== undefined) {
    throw new Error('Only Web pages have an HTML output style.');
  }
  if (
    (await providerEntryExists(provider, layout.targetPath)) ||
    (await providerEntryExists(provider, layout.companionDirectory))
  ) {
    throw new FsError(
      'already-exists',
      'A file or companion folder with that name already exists.',
      {
        operation: 'write',
        path: layout.targetPath,
      },
    );
  }

  let content = await withOutsideInMarkdownEditing(`# ${layout.stem}\n`, layout);
  if (layout.format === 'html') {
    content = await withOutsideInHtmlOutput(content, htmlOutput ?? 'interactive');
  }
  const prepared = await prepareOutsideInRender(provider, layout, content);
  if (prepared.runtimePath) await writeRuntimeIfNeeded(provider, prepared.runtimePath);
  // Publish the visible target first. If the second create loses a race, the
  // rendered file remains a valid importable document instead of leaving only
  // a hidden companion behind.
  await writeBytes(provider, layout.targetPath, prepared.bytes, 'create');
  await writeProviderText(provider, layout.markdownPath, content, 'create');
  return {
    displayPath: layout.targetPath,
    sourcePath: layout.markdownPath,
    content,
    outsideIn: layout,
    outsideInEditingEnabled: true,
  };
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
      if (!(await isOutsideInMarkdownEditingEnabled(request.content))) {
        throw new Error(
          'Outside-in editing is read-only until squisq-updatefrommarkdown: true is set.',
        );
      }
      const rendered = await prepareOutsideInRender(provider, layout, request.content);

      await sourceTarget.commit({ ...request, targetKey: sourceTarget.key });
      if (rendered.runtimePath) await writeRuntimeIfNeeded(provider, rendered.runtimePath);
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
