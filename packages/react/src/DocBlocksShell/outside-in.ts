import {
  FileSystemContentContainer,
  FsError,
  SQUISQ_RUNTIME_DIRECTORY_NAME,
  getFileSystemProviderV2,
  findWikiArticle,
  isDiscoverableWorkspaceEntry,
  parseWorkspacePath,
  type FileSystemProvider,
} from '@bendyline/docblocks/filesystem';
import {
  createFileSystemDocumentTarget,
  type DocumentCommitTarget,
} from '@bendyline/docblocks/document';
import {
  isGeneratedCatalogHtml,
  isGeneratedCatalogJson,
} from '@bendyline/docblocks/workspace-settings';
import type { ContentContainer } from '@bendyline/squisq/storage';
import type { MarkdownDocument } from '@bendyline/squisq/markdown';
import type { DiagramRasterizer } from '@bendyline/squisq-formats/diagrams';
import { resolveShellEditorLinkTarget } from './editor-link-navigation.js';
import { providerEntryExists, writeProviderText } from './provider-io.js';
import {
  chooseOutsideInMarkdownPath,
  importOutsideInDocument,
  isOutsideInMarkdownEditingEnabled,
  isOutsideInDataFormat,
  loadPageTemplateEngine,
  loadPlainHtmlPreparation,
  loadPlainHtmlRenderer,
  readFrontmatterTheme,
  readOutsideInHtmlOutput,
  readOutsideInMetadata,
  readOutsideInOutputTemplate,
  renderOutsideInDocument,
  resolveOutsideInLayout,
  withOutsideInHtmlOutput,
  withOutsideInMarkdownEditing,
  withOutsideInMetadata,
  type OutsideInFormatId,
  type OutsideInLayout,
  type OutsideInHtmlOutput,
  type PlainHtmlIcons,
} from './outside-in-contract.js';

export type { OutsideInLayout } from './outside-in-contract.js';
export {
  resolveOutsideInLayout,
  relocateOutsideInLayout,
  withOutsideInMetadata,
} from './outside-in-contract.js';

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
const SQUISQ_RUNTIME_FILENAME = 'squisq-player.js';
const PENDING_RENDER_FILENAME = '.docblocks-pending-render';
const PENDING_RENDER_CONTENT = 'docblocks-outside-in-pending-render-v1\n';

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
  /**
   * Set for a workspace catalog file DocBlocks generates. `content` is the
   * file's own text; the shell shows it read-only (the page rendered in a
   * sandboxed frame) and never saves or imports it.
   */
  managedOutput?: 'catalog-html' | 'catalog-json';
}

/** Host-supplied rendering context for regenerated outside-in files. */
export interface OutsideInRenderOptions {
  /**
   * The workspace default theme, read at render time. Applied only to
   * documents whose frontmatter names no theme of their own: every Squisq
   * exporter lets an explicit theme beat the document's frontmatter.
   */
  defaultThemeId?: () => string | undefined;
  /**
   * The workspace default page template for a rendered format, as a
   * workspace-relative path, read at render time. Applied only to documents
   * whose frontmatter names no template (`squisq-output-template`) of their
   * own, and never to interactive Web pages.
   */
  defaultOutputTemplate?: (format: OutsideInFormatId) => string | undefined;
  /**
   * Draws diagrams and charts as pictures for rendered files that cannot draw
   * them: static and templated Web pages, Word, PDF, and PowerPoint. Defaults
   * to Squisq's browser renderer; null leaves them as their source.
   */
  renderDiagram?: DiagramRasterizer | null;
}

/**
 * Pictures already drawn, by diagram. Every save renders the whole file, so
 * without this each save would redraw every diagram, not just the one edited.
 */
const drawnPictures = new Map<string, ReturnType<DiagramRasterizer>>();
const DRAWN_PICTURE_LIMIT = 64;

/** Squisq's browser renderer, loaded only once a document has a diagram. */
const drawWithSquisq: DiagramRasterizer = (diagram) => {
  const key = `${diagram.kind}\n${diagram.markdown}\n${diagram.source}`;
  let picture = drawnPictures.get(key);
  if (picture) {
    drawnPictures.delete(key);
  } else {
    picture = import('@bendyline/squisq-react/diagram-pictures').then(
      ({ createDiagramPictureRenderer }) => createDiagramPictureRenderer()(diagram),
    );
    // A failure is retried on the next save rather than remembered.
    picture.catch(() => drawnPictures.delete(key));
  }
  drawnPictures.set(key, picture);
  if (drawnPictures.size > DRAWN_PICTURE_LIMIT) {
    drawnPictures.delete(drawnPictures.keys().next().value!);
  }
  return picture;
};

/** The render's diagram renderer: the host's, else Squisq's browser one. */
function diagramRendererFor(
  render: OutsideInRenderOptions | undefined,
): DiagramRasterizer | undefined {
  if (render?.renderDiagram !== undefined) return render.renderDiagram ?? undefined;
  return drawWithSquisq;
}

/**
 * A page template that is missing or unusable. Raised while preparing a
 * render, before anything is written, so the visible page keeps its last good
 * output and the edit stays a retryable unsaved revision.
 */
export class OutsideInTemplateError extends Error {
  constructor(
    /** The template as configured: an authored frontmatter value or workspace path. */
    readonly template: string,
    message: string,
  ) {
    super(message);
    this.name = 'OutsideInTemplateError';
  }
}

async function resolveFallbackRenderTheme(
  markdown: string,
  render: OutsideInRenderOptions | undefined,
): Promise<string | undefined> {
  const fallback = render?.defaultThemeId?.();
  if (!fallback) return undefined;
  return (await readFrontmatterTheme(markdown)) ? undefined : fallback;
}

export interface EditableOutsideInDocument extends EditableShellDocument {
  outsideIn: OutsideInLayout;
  outsideInEditingEnabled: true;
}

/** Data cards should use the viewport-filling editor layout on open. */
export function defaultOutsideInLayoutMode(outsideIn: OutsideInLayout | null): 'block' | undefined {
  return outsideIn && isOutsideInDataFormat(outsideIn.format) ? 'block' : undefined;
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

async function clearPendingRender(
  provider: FileSystemProvider,
  layout: OutsideInLayout,
): Promise<void> {
  const marker = join(layout.companionDirectory, PENDING_RENDER_FILENAME);
  const v2 = getFileSystemProviderV2(provider);
  if (v2) await v2.remove(parseWorkspacePath(marker), { missing: 'ignore' });
  else if (await provider.exists(marker)) await provider.delete(marker);
}

async function finishPendingRender(
  provider: FileSystemProvider,
  layout: OutsideInLayout,
  content: string,
  render?: OutsideInRenderOptions,
): Promise<void> {
  const marker = await readText(provider, join(layout.companionDirectory, PENDING_RENDER_FILENAME));
  if (marker === null) return;
  if (marker !== PENDING_RENDER_CONTENT)
    throw new Error('The pending document render record is corrupt.');
  if (!(await isOutsideInMarkdownEditingEnabled(content))) {
    throw new Error('The document has an unfinished save, but Markdown regeneration is disabled.');
  }
  // Finish the derived output before a new session can acknowledge the source.
  // A failure keeps the marker for the next open or retry.
  const rendered = await prepareOutsideInRender(provider, layout, content, render);
  if (rendered.runtimePath) await writeRuntimeIfNeeded(provider, rendered.runtimePath);
  await writeBytes(provider, layout.targetPath, rendered.bytes);
  await clearPendingRender(provider, layout);
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
  render?: OutsideInRenderOptions,
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
    if (content === null) return null;
    const generatedCatalog = /\.json$/i.test(selectedPath) && isGeneratedCatalogJson(content);
    return {
      displayPath: selectedPath,
      sourcePath: selectedPath,
      content,
      outsideIn: null,
      outsideInEditingEnabled: !generatedCatalog,
      ...(generatedCatalog ? { managedOutput: 'catalog-json' as const } : {}),
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
    await finishPendingRender(provider, { ...layout, markdownPath: chosen }, linkedContent, render);
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
  if (layout.format === 'html') {
    // A catalog page DocBlocks generates is shown as the page it is and never
    // imported: importing would create a companion and make it editable.
    const head = new TextDecoder().decode(rendered.slice(0, 4096));
    if (isGeneratedCatalogHtml(head)) {
      return {
        displayPath: selectedPath,
        sourcePath: selectedPath,
        content: new TextDecoder().decode(rendered),
        outsideIn: null,
        outsideInEditingEnabled: false,
        managedOutput: 'catalog-html',
      };
    }
    // A page template is edited as HTML source. Importing it would flatten
    // its chrome into Markdown and regenerate it without its slots.
    const source = new TextDecoder().decode(rendered);
    if ((await loadPageTemplateEngine())?.isHtmlPageTemplate(source)) {
      return {
        displayPath: selectedPath,
        sourcePath: selectedPath,
        content: source,
        outsideIn: null,
        outsideInEditingEnabled: true,
      };
    }
  }
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
    const candidateDirectory = join(directory, SQUISQ_RUNTIME_DIRECTORY_NAME);
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
  return join(SQUISQ_RUNTIME_DIRECTORY_NAME, SQUISQ_RUNTIME_FILENAME);
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
 * Companion files — media, attachments, data — addressed from the rendered
 * page beside the companion folder.
 */
async function companionImageMap(
  provider: FileSystemProvider,
  layout: OutsideInLayout,
): Promise<Map<string, string> | undefined> {
  const container = new FileSystemContentContainer(provider, layout.companionDirectory);
  const images = new Map<string, string>();
  for (const entry of await container.listFiles()) {
    const outputPath = `${layout.companionName}/${entry.path}`;
    images.set(entry.path, outputPath);
    images.set(`./${entry.path}`, outputPath);
  }
  return images.size > 0 ? images : undefined;
}

interface StaticPageContent {
  markdown: MarkdownDocument;
  /** Companion files, then pictures of the document's diagrams and charts. */
  images: Map<string, string> | undefined;
  /** Companion files, so links to attachments and data resolve from the page. */
  links: Map<string, string> | undefined;
  /** Inline icons as SVG outlines, so the page needs no icon font. */
  icons?: PlainHtmlIcons;
}

/**
 * What a script-free page shows: the document with its data tables filled
 * from the companion's sidecars and its diagrams and charts drawn as
 * pictures, since nothing on the page can draw them.
 */
async function prepareStaticPage(
  provider: FileSystemProvider,
  layout: OutsideInLayout,
  markdown: MarkdownDocument,
  render: OutsideInRenderOptions | undefined,
): Promise<StaticPageContent> {
  const files = await companionImageMap(provider, layout);
  const prepare = await loadPlainHtmlPreparation();
  if (!prepare) return { markdown, images: files, links: files };
  const prepared = await prepare(markdown, {
    renderDiagram: diagramRendererFor(render),
    container: createOutsideInContentContainer(provider, layout),
  });
  return {
    markdown: prepared.markdownDoc,
    images: prepared.images.size > 0 ? new Map([...(files ?? []), ...prepared.images]) : files,
    links: files,
    icons: prepared.icons,
  };
}

async function renderPlainOutsideInHtml(
  provider: FileSystemProvider,
  layout: OutsideInLayout,
  markdown: MarkdownDocument,
  themeId: string | undefined,
  render: OutsideInRenderOptions | undefined,
): Promise<Uint8Array> {
  const markdownDocToPlainHtml = await loadPlainHtmlRenderer();
  const page = await prepareStaticPage(provider, layout, markdown, render);
  return new TextEncoder().encode(
    markdownDocToPlainHtml(page.markdown, {
      title: layout.stem,
      images: page.images,
      links: page.links,
      icons: page.icons,
      ...(themeId ? { themeId } : {}),
    }),
  );
}

interface OutputTemplateChoice {
  /** As configured, for messages. */
  configured: string;
  /** Resolved workspace path of the template file. */
  path: string;
}

/**
 * The page template a render must use: the companion's own
 * `squisq-output-template` (relative to the companion Markdown, or `/`-rooted
 * at the workspace), else the workspace default, else none. `none` opts out
 * of the default. Interactive pages render through the player and take no
 * template; naming one for them is an error rather than a silent no-op.
 */
async function resolveOutputTemplate(
  layout: OutsideInLayout,
  markdown: string,
  htmlOutput: OutsideInHtmlOutput | null,
  render: OutsideInRenderOptions | undefined,
): Promise<OutputTemplateChoice | null> {
  const authored = await readOutsideInOutputTemplate(markdown);
  if (authored === 'none') return null;
  if (authored === null) {
    if (layout.format !== 'html' || htmlOutput === 'interactive') return null;
    const fallback = render?.defaultOutputTemplate?.(layout.format);
    return fallback ? { configured: fallback, path: parseWorkspacePath(fallback) } : null;
  }
  if (layout.format !== 'html') {
    throw new OutsideInTemplateError(authored, 'Page templates are supported for Web pages only.');
  }
  if (htmlOutput === 'interactive') {
    throw new OutsideInTemplateError(
      authored,
      'Interactive Web pages cannot use a page template. Set squisq-html-output to static, or remove squisq-output-template.',
    );
  }
  const target = resolveShellEditorLinkTarget(authored, layout.markdownPath);
  if (target?.kind !== 'workspace' || !/\.html?$/i.test(target.path)) {
    throw new OutsideInTemplateError(
      authored,
      `The page template "${authored}" must be an .html file in this workspace.`,
    );
  }
  return { configured: authored, path: target.path };
}

function frontmatterText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

async function renderTemplatedOutsideInHtml(
  provider: FileSystemProvider,
  layout: OutsideInLayout,
  markdown: MarkdownDocument,
  template: OutputTemplateChoice,
  themeId: string | undefined,
  render: OutsideInRenderOptions | undefined,
): Promise<Uint8Array> {
  const fail: (reason: string) => never = (reason) => {
    throw new OutsideInTemplateError(
      template.configured,
      `The page template "${template.path}" ${reason}`,
    );
  };
  const outputPath = parseWorkspacePath(layout.targetPath);
  if (template.path === outputPath) fail('is this page itself; a page cannot be its own template.');
  const engine = await loadPageTemplateEngine();
  if (!engine)
    fail('cannot be applied: this version of DocBlocks does not support page templates.');
  let source: string | null;
  try {
    source = await readText(provider, withLegacySlash(template.path, layout.targetPath));
  } catch (error: unknown) {
    if (error instanceof FsError && error.code === 'not-found') source = null;
    else if (error instanceof TypeError) fail('is not UTF-8 text.');
    else throw error;
  }
  if (source === null) fail('was not found.');

  const { inferDocumentTitle } = await import('@bendyline/squisq/markdown');
  const title = inferDocumentTitle(markdown) ?? layout.stem;
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(markdown.frontmatter ?? {})) {
    const text = frontmatterText(value);
    if (text !== undefined) values[key] = text;
  }
  const content = await prepareStaticPage(provider, layout, markdown, render);
  const parts = engine.markdownDocToPlainHtmlParts(content.markdown, {
    title,
    images: content.images,
    links: content.links,
    icons: content.icons,
    ...(themeId ? { themeId } : {}),
  });
  let page: string;
  try {
    page = engine.applyHtmlPageTemplate(
      source,
      { bodyHtml: parts.bodyHtml, headHtml: parts.featureHeadHtml, title, values },
      { templatePath: template.path, outputPath },
    );
  } catch (error: unknown) {
    fail(`can't be used. ${error instanceof Error ? error.message : String(error)}`);
  }
  return new TextEncoder().encode(page);
}

interface PreparedOutsideInRender {
  bytes: Uint8Array;
  runtimePath: string | null;
}

async function prepareOutsideInRender(
  provider: FileSystemProvider,
  layout: OutsideInLayout,
  markdown: string,
  render?: OutsideInRenderOptions,
): Promise<PreparedOutsideInRender> {
  const themeId = await resolveFallbackRenderTheme(markdown, render);
  const htmlOutput = layout.format === 'html' ? await readOutsideInHtmlOutput(markdown) : null;
  let renderedSource: string | MarkdownDocument = markdown;
  if (layout.format === 'html') {
    const { parseMarkdown, resolveWikiLinks } = await import('@bendyline/squisq/markdown');
    renderedSource = await resolveWikiLinks(parseMarkdown(markdown), async (target) => {
      const article = await findWikiArticle(provider, layout.targetPath, target, '.html');
      return article.exists
        ? article.relativePath.split('/').map(encodeURIComponent).join('/')
        : null;
    });
  }
  const template = await resolveOutputTemplate(layout, markdown, htmlOutput, render);
  if (template) {
    return {
      bytes: await renderTemplatedOutsideInHtml(
        provider,
        layout,
        renderedSource as MarkdownDocument,
        template,
        themeId,
        render,
      ),
      runtimePath: null,
    };
  }
  if (htmlOutput === 'static') {
    return {
      bytes: await renderPlainOutsideInHtml(
        provider,
        layout,
        renderedSource as MarkdownDocument,
        themeId,
        render,
      ),
      runtimePath: null,
    };
  }

  const runtimePath =
    layout.format === 'html' ? await findRuntimePath(provider, layout.targetPath) : null;
  const outputDirectory = dirname(layout.targetPath);
  const rendered = await renderOutsideInDocument(
    {
      markdown: renderedSource,
      targetPath: layout.targetPath,
      container: new FileSystemContentContainer(provider, layout.companionDirectory),
    },
    {
      ...(themeId ? { themeId } : {}),
      renderDiagram: diagramRendererFor(render),
      ...(runtimePath
        ? {
            html: {
              playerScriptPath: relativePath(outputDirectory, runtimePath),
              basePath: relativePath(outputDirectory, layout.companionDirectory),
            },
            ...(htmlOutput === 'interactive'
              ? { formatOptions: { html: { mode: 'slideshow' as const } } }
              : {}),
          }
        : {}),
    },
  );
  return { bytes: rendered.bytes, runtimePath };
}

/** Outcome of regenerating the pages generated through one page template. */
export interface TemplatePagesResult {
  /** Rendered pages whose output changed and was rewritten. */
  readonly updated: string[];
  readonly failed: Array<{ readonly path: string; readonly message: string }>;
}

const TEMPLATE_PAGE_WALK_LIMITS = { maxDepth: 32, maxDirectories: 20_000 } as const;

interface WorkspaceHtmlFile {
  /** Canonical workspace path. */
  path: string;
  /** A `<stem>_files` companion sits beside it: a generated outside-in page. */
  hasCompanion: boolean;
}

/** Every discoverable `.html` file in the workspace, sorted by path. */
async function listWorkspaceHtmlFiles(provider: FileSystemProvider): Promise<WorkspaceHtmlFile[]> {
  const providerV2 = getFileSystemProviderV2(provider);
  const pages: WorkspaceHtmlFile[] = [];
  const pending: Array<{ path: string; depth: number }> = [{ path: '', depth: 0 }];
  let directories = 0;
  while (pending.length > 0 && directories < TEMPLATE_PAGE_WALK_LIMITS.maxDirectories) {
    const { path, depth } = pending.pop()!;
    directories++;
    let entries: ReadonlyArray<{ kind: 'file' | 'directory'; name: string; path: string }>;
    try {
      entries = providerV2
        ? await providerV2.readDirectory(parseWorkspacePath(path))
        : await provider.readDirectory(path ? `/${path}` : '/');
    } catch (error: unknown) {
      if (error instanceof FsError && error.code === 'not-found') continue;
      throw error;
    }
    const directoryNames = new Set(
      entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.name),
    );
    for (const entry of entries) {
      if (!isDiscoverableWorkspaceEntry(entry.name, entry.kind)) continue;
      const entryPath = parseWorkspacePath(entry.path);
      if (entry.kind === 'directory') {
        if (depth < TEMPLATE_PAGE_WALK_LIMITS.maxDepth) {
          pending.push({ path: entryPath, depth: depth + 1 });
        }
      } else if (/\.html?$/i.test(entry.name)) {
        const companionName = resolveOutsideInLayout(entryPath)?.companionName;
        pages.push({
          path: entryPath,
          hasCompanion: companionName !== undefined && directoryNames.has(companionName),
        });
      }
    }
  }
  return pages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const PAGE_TEMPLATE_SCAN_LIMITS = { maxFiles: 500, maxBytes: 1024 * 1024 } as const;

/**
 * The page templates in a workspace, as canonical paths: HTML files with a
 * `<slot>` outside any `<template>`. Generated outside-in pages are skipped
 * unread, so a blog of many posts reads only its handful of other HTML files.
 */
export async function findPageTemplates(provider: FileSystemProvider): Promise<string[]> {
  const engine = await loadPageTemplateEngine();
  if (!engine) return [];
  const templates: string[] = [];
  let scanned = 0;
  for (const file of await listWorkspaceHtmlFiles(provider)) {
    if (file.hasCompanion) continue;
    if (++scanned > PAGE_TEMPLATE_SCAN_LIMITS.maxFiles) break;
    const bytes = await readBytes(
      provider,
      getFileSystemProviderV2(provider) ? file.path : `/${file.path}`,
    );
    if (!bytes || bytes.byteLength > PAGE_TEMPLATE_SCAN_LIMITS.maxBytes) continue;
    if (engine.isHtmlPageTemplate(new TextDecoder().decode(bytes))) templates.push(file.path);
  }
  return templates;
}

function sameBytes(a: ArrayBuffer | Uint8Array, b: Uint8Array): boolean {
  const left = a instanceof Uint8Array ? a : new Uint8Array(a);
  if (left.byteLength !== b.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) if (left[index] !== b[index]) return false;
  return true;
}

/**
 * Regenerate every editable Web page generated through the page template at
 * `templatePath`, so a change to shared chrome (navigation, footer) reaches
 * pages nobody is editing. Companion Markdown is never touched, and a page is
 * rewritten only when its output changes.
 */
export async function rerenderPagesUsingTemplate(
  provider: FileSystemProvider,
  templatePath: string,
  render?: OutsideInRenderOptions,
): Promise<TemplatePagesResult> {
  const template = parseWorkspacePath(templatePath);
  const result: TemplatePagesResult = { updated: [], failed: [] };
  for (const { path: page, hasCompanion } of await listWorkspaceHtmlFiles(provider)) {
    if (!hasCompanion || page === template) continue;
    const resolved = resolveOutsideInLayout(page);
    if (!resolved) continue;
    const markdownPath = chooseOutsideInMarkdownPath(
      resolved,
      await listCompanionFiles(provider, resolved),
    );
    if (!markdownPath) continue;
    const layout: OutsideInLayout = { ...resolved, markdownPath };
    try {
      const content = await readText(provider, markdownPath);
      if (content === null || !(await isOutsideInMarkdownEditingEnabled(content))) continue;
      const htmlOutput = await readOutsideInHtmlOutput(content);
      const choice = await resolveOutputTemplate(layout, content, htmlOutput, render).catch(
        () => null,
      );
      if (choice?.path !== template) continue;
      const rendered = await prepareOutsideInRender(provider, layout, content, render);
      const current = await readBytes(provider, layout.targetPath);
      if (current && sameBytes(current, rendered.bytes)) continue;
      await writeBytes(provider, layout.targetPath, rendered.bytes);
      result.updated.push(layout.targetPath);
    } catch (error: unknown) {
      result.failed.push({
        path: layout.targetPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
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
  render?: OutsideInRenderOptions,
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
  const prepared = await prepareOutsideInRender(provider, layout, content, render);
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
  render?: OutsideInRenderOptions,
): DocumentCommitTarget {
  const sourceTarget = createFileSystemDocumentTarget(provider, layout.markdownPath);
  let partialSource: { baseline: string | null; content: string } | undefined;
  return {
    key: `${provider.id}:outside-in:${parseWorkspacePath(layout.targetPath)}`,
    async commit(request) {
      if (!(await isOutsideInMarkdownEditingEnabled(request.content))) {
        throw new Error(
          'Outside-in editing is read-only until squisq-updatefrommarkdown: true is set.',
        );
      }
      const rendered = await prepareOutsideInRender(provider, layout, request.content, render);
      await writeProviderText(
        provider,
        join(layout.companionDirectory, PENDING_RENDER_FILENAME),
        PENDING_RENDER_CONTENT,
      );
      await sourceTarget.commit({
        ...request,
        targetKey: sourceTarget.key,
        persistedContent:
          partialSource?.baseline === request.persistedContent
            ? partialSource.content
            : request.persistedContent,
      });
      // Keep our source acknowledgement even if a later derived write fails.
      // The source target still checks the real bytes for external changes.
      partialSource = { baseline: request.persistedContent, content: request.content };
      if (rendered.runtimePath) await writeRuntimeIfNeeded(provider, rendered.runtimePath);
      await writeBytes(provider, layout.targetPath, rendered.bytes);
      await clearPendingRender(provider, layout);
      partialSource = undefined;
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
