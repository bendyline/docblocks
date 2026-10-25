/**
 * Execute an export using @bendyline/squisq-formats.
 */

import type {
  MarkdownDocument,
  MarkdownBlockNode,
  MarkdownInlineNode,
} from '@bendyline/squisq/markdown';
import {
  isSvgImageSource,
  parseFrontmatter,
  parseMarkdown,
  readFrontmatterThemeId,
  splitFrontmatterBlock,
  svgSourceFromBytes,
} from '@bendyline/squisq/markdown';
import type { Doc } from '@bendyline/squisq/schemas';
import type { ContentContainer } from '@bendyline/squisq/storage';
import type {
  DiagramPicture,
  DiagramRasterizer,
  ExportDiagramKind,
  RasterizedDiagrams,
} from '@bendyline/squisq-formats/diagrams';
import type { ExportOptions, ExportFormat } from './export-options.js';
import { FORMAT_EXTENSIONS } from './export-options.js';
import { PdfReplacementsError } from './export-errors.js';
export { buildExportFilename } from './export-filename.js';

export type ExportBlobSaver = (blob: Blob, filename: string) => Promise<void> | void;

/** Host-provided converters that must be loaded before an export begins. */
export interface ExportConverterOverrides {
  docToPptx?: (typeof import('@bendyline/squisq-formats/pptx'))['docToPptx'];
  /**
   * Draws diagrams as pictures. Defaults to Squisq's browser renderer; tests
   * pass a stand-in because drawing needs a real canvas.
   */
  diagramRenderer?: DiagramRasterizer;
}

/** The host's diagram renderer, or Squisq's browser one. */
async function diagramRendererFor(overrides: ExportConverterOverrides): Promise<DiagramRasterizer> {
  if (overrides.diagramRenderer) return overrides.diagramRenderer;
  const module = await import('@bendyline/squisq-react/diagram-pictures');
  return module.createDiagramPictureRenderer();
}

/**
 * Pictures of the document's diagrams — Mermaid, timelines, ASCII diagrams,
 * file trees, drawings and layouts — which Word, EPUB, PDF and PowerPoint
 * cannot draw themselves, so without these they export as source text. A
 * diagram that cannot be drawn stays as source; the export never fails on it.
 *
 * SVG islands are pictured only on request (`'svg'`, or `'all'` for PDF):
 * Word and PowerPoint embed them as vector art and use the pictures only as
 * the PNG fallback stored beside it.
 */
async function pictureDiagrams(
  doc: MarkdownDocument,
  overrides: ExportConverterOverrides,
  kinds?: readonly ExportDiagramKind[] | 'all',
): Promise<RasterizedDiagrams> {
  try {
    const [{ rasterizeDiagrams, EXPORT_DIAGRAM_KINDS }, render] = await Promise.all([
      import('@bendyline/squisq-formats/diagrams'),
      diagramRendererFor(overrides),
    ]);
    return await rasterizeDiagrams(doc, render, {
      kinds: kinds === 'all' ? EXPORT_DIAGRAM_KINDS : kinds,
      urlPrefix: 'docblocks-diagram',
    });
  } catch {
    return { markdownDoc: doc, images: new Map(), mermaid: new Map(), svg: new Map() };
  }
}

/**
 * PNG pictures of the SVG files among a document's images, keyed by each
 * file's trimmed text — the key Word's `svgIslandFallbacks` and PowerPoint's
 * `diagramImages` look a fallback up by. A file that is not a usable SVG, or
 * cannot be drawn, is left out and keeps its vector art or alt text.
 */
async function pictureSvgAttachments(
  attachments: Iterable<readonly [string, ArrayBuffer | Uint8Array]>,
  overrides: ExportConverterOverrides,
): Promise<Map<string, DiagramPicture>> {
  const pictures = new Map<string, DiagramPicture>();
  const sources = new Set<string>();
  for (const [url, data] of attachments) {
    if (isSvgImageSource(url)) sources.add(svgSourceFromBytes(data).trim());
  }
  if (sources.size === 0) return pictures;
  try {
    const render = await diagramRendererFor(overrides);
    for (const source of sources) {
      // One SVG that cannot be drawn must not cost the others theirs.
      const diagram = { kind: 'svg', markdown: '', source, template: '', alt: '' } as const;
      const picture = await render(diagram).catch(() => null);
      if (picture && picture.width > 0 && picture.height > 0) pictures.set(source, picture);
    }
  } catch {
    // No renderer: every SVG keeps its vector art or alt text.
  }
  return pictures;
}

/** The `data` of each entry in an image map, for `pictureSvgAttachments`. */
function imageBytes(
  images: ReadonlyMap<string, { data: ArrayBuffer | Uint8Array }>,
): [string, ArrayBuffer | Uint8Array][] {
  return [...images].map(([url, image]) => [url, image.data]);
}

const MIME_TYPES: Record<ExportFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip',
  md: 'text/markdown',
  html: 'text/html',
};

/** Trigger a browser download for a Blob. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function saveExportBlob(
  blob: Blob,
  filename: string,
  saveBlob?: ExportBlobSaver,
): Promise<void> {
  if (saveBlob) {
    await saveBlob(blob, filename);
    return;
  }
  downloadBlob(blob, filename);
}

/**
 * The theme id handed to Squisq's exporters. Given none, they fall back to the
 * document's own frontmatter theme, so Standard stays implicit only when the
 * document names no theme of its own; choosing Standard over a themed
 * document must say so, or the export silently keeps the document's theme.
 */
export function exporterThemeId(markdown: string, selectedThemeId: string): string | undefined {
  if (selectedThemeId !== 'standard') return selectedThemeId;
  const block = splitFrontmatterBlock(markdown).frontmatter;
  const firstBreak = block ? block.indexOf('\n') : -1;
  if (!block || firstBreak < 0) return undefined;
  const yaml = block.slice(firstBreak + 1).replace(/\r?\n---(?:\r?\n)?$/, '');
  return readFrontmatterThemeId(parseFrontmatter(yaml) ?? undefined) ? selectedThemeId : undefined;
}

/** Derive a filename from the selected file path and export format. */
function buildFilename(selectedFile: string | null, format: ExportFormat): string {
  const base = selectedFile ? selectedFile.replace(/^\//, '').replace(/\.[^.]+$/, '') : 'document';
  return base + FORMAT_EXTENSIONS[format];
}

/** What an export reports beyond the saved file. */
export interface ExportResult {
  /**
   * What the user should know about the file that was saved, such as
   * characters PDF export had to replace. Empty when nothing was lost.
   */
  readonly warnings: readonly string[];
}

/** Choices the user made for this one export, as opposed to its saved options. */
export interface ExportBehavior {
  /**
   * Save a PDF even though its fonts replace some characters. Without it,
   * such an export throws `PdfReplacementsError` before saving anything.
   */
  allowPdfReplacements?: boolean;
}

/** Run the export and trigger a download. */
export async function runExport(
  markdown: string,
  selectedFile: string | null,
  options: ExportOptions,
  mediaContainer?: ContentContainer | null,
  saveBlob?: ExportBlobSaver,
  converterOverrides: ExportConverterOverrides = {},
  behavior: ExportBehavior = {},
): Promise<ExportResult> {
  const warnings: string[] = [];
  await exportDocument(
    markdown,
    selectedFile,
    options,
    mediaContainer,
    saveBlob,
    converterOverrides,
    behavior,
    warnings,
  );
  return { warnings };
}

async function exportDocument(
  markdown: string,
  selectedFile: string | null,
  options: ExportOptions,
  mediaContainer: ContentContainer | null | undefined,
  saveBlob: ExportBlobSaver | undefined,
  converterOverrides: ExportConverterOverrides,
  behavior: ExportBehavior,
  warnings: string[],
): Promise<void> {
  const filename = buildFilename(selectedFile, options.format);
  const themeId = exporterThemeId(markdown, options.themeId);

  if (options.format === 'md') {
    await saveExportBlob(new Blob([markdown], { type: MIME_TYPES.md }), filename, saveBlob);
    return;
  }

  if (options.format === 'html') {
    await runHtmlExport(markdown, filename, options, mediaContainer, selectedFile, saveBlob);
    return;
  }

  const doc = parseMarkdown(markdown);

  if (options.format === 'docx') {
    const { markdownDocToDocx } = await import('@bendyline/squisq-formats/docx');
    const pictured = await pictureDiagrams(doc, converterOverrides);
    // SVG islands and attached SVGs go in as vector art; their pictures are
    // only the PNG fallback Word stores beside it for older readers.
    const { svg } = await pictureDiagrams(doc, converterOverrides, ['svg']);
    const attachments = await resolveImages(doc, mediaContainer);
    const svgAttachments = await pictureSvgAttachments(imageBytes(attachments), converterOverrides);
    const images = new Map([...attachments, ...pictured.images]);
    const buf = await markdownDocToDocx(pictured.markdownDoc, {
      themeId,
      images,
      svgIslandFallbacks: new Map([...svg, ...svgAttachments]),
    });
    await saveExportBlob(new Blob([buf], { type: MIME_TYPES.docx }), filename, saveBlob);
    return;
  }

  if (options.format === 'pdf') {
    const { markdownDocToPdf } = await import('@bendyline/squisq-formats/pdf');
    // PDF has no vector picture of its own: SVG islands are pictured too,
    // and each attached SVG is swapped for its PNG.
    const pictured = await pictureDiagrams(doc, converterOverrides, 'all');
    const attachments = await resolveImages(doc, mediaContainer);
    const svgPictures = await pictureSvgAttachments(imageBytes(attachments), converterOverrides);
    const images = new Map([...withSvgPictures(attachments, svgPictures), ...pictured.images]);
    const buf = await markdownDocToPdf(pictured.markdownDoc, {
      themeId,
      pageSize: options.pageSize,
      images,
      // Check fidelity before any download or destination write occurs.
      onWarning: (message) => warnings.push(message),
    });
    if (warnings.length > 0 && !behavior.allowPdfReplacements) {
      throw new PdfReplacementsError([...warnings]);
    }
    await saveExportBlob(new Blob([buf], { type: MIME_TYPES.pdf }), filename, saveBlob);
    return;
  }

  if (options.format === 'epub') {
    const { markdownDocToEpub } = await import('@bendyline/squisq-formats/epub');
    const pictured = await pictureDiagrams(doc, converterOverrides);
    const images = new Map([
      ...(mediaContainer ? await resolveImageData(doc, mediaContainer) : []),
      ...[...pictured.images].map(
        ([url, picture]) => [url, picture.data.slice().buffer as ArrayBuffer] as const,
      ),
    ]);
    const buf = await markdownDocToEpub(pictured.markdownDoc, { themeId, images });
    await saveExportBlob(new Blob([buf], { type: MIME_TYPES.epub }), filename, saveBlob);
    return;
  }

  if (options.format === 'pptx') {
    const pptxModule = converterOverrides.docToPptx
      ? Promise.resolve({ docToPptx: converterOverrides.docToPptx })
      : import('@bendyline/squisq-formats/pptx');
    const [
      { markdownToDoc },
      { applyTransform, PRESENTATION_KEY },
      { buildPreviewDoc },
      { docToPptx },
    ] = await Promise.all([
      import('@bendyline/squisq/doc'),
      import('@bendyline/squisq/transform'),
      import('@bendyline/squisq-editor-react'),
      pptxModule,
    ]);
    // Use the exact slideshow projection before PPTX conversion. The player
    // and exporter therefore share block flattening, typed template inputs,
    // image interleaving, synthetic timing, and the later expandDocBlocks pass.
    const baseDoc = markdownToDoc(doc);
    if (!options.transformStyle) {
      // None also overrides saved slide summaries for this export. Work on a
      // copy: buildPreviewDoc otherwise applies dynamic or legacy plans itself.
      baseDoc.frontmatter = { ...baseDoc.frontmatter };
      delete baseDoc.frontmatter['squisq-transform'];
      delete baseDoc.frontmatter['transform-style'];
      delete baseDoc.frontmatter[PRESENTATION_KEY];
    }
    const contentDoc = options.transformStyle
      ? applyTransform(baseDoc, options.transformStyle).doc
      : baseDoc;
    const enrichedDoc = buildPreviewDoc(contentDoc);
    if (themeId) {
      enrichedDoc.themeId = themeId;
    }
    const images = mediaContainer ? await resolveImageData(doc, mediaContainer) : undefined;
    // Drawings, timelines and ASCII diagrams become native slide shapes;
    // Mermaid needs a picture, and an SVG island's or attached SVG's picture
    // is the PNG fallback stored beside its vector art.
    const { mermaid, svg } = await pictureDiagrams(doc, converterOverrides, ['mermaid', 'svg']);
    const svgAttachments = await pictureSvgAttachments(images ?? [], converterOverrides);
    const buf = await docToPptx(enrichedDoc, {
      themeId,
      images,
      diagramImages: new Map([...mermaid, ...svg, ...svgAttachments]),
    });
    await saveExportBlob(new Blob([buf], { type: MIME_TYPES.pptx }), filename, saveBlob);
    return;
  }
}

/** A Mermaid fence anywhere in a markdown source. */
const MERMAID_FENCE = /^ {0,3}(?:```|~~~)[ \t]*mermaid\b/imu;

/**
 * The player script for a rendered HTML export. Squisq's light player leaves
 * Mermaid out, so a document with a Mermaid diagram gets the full player;
 * everything else keeps the smaller one.
 */
async function playerScriptFor(markdown: string): Promise<string> {
  if (MERMAID_FENCE.test(markdown)) {
    const { PLAYER_BUNDLE_FULL } = await import('@bendyline/squisq-react/standalone-source/full');
    return PLAYER_BUNDLE_FULL;
  }
  const { PLAYER_BUNDLE } = await import('@bendyline/squisq-react/standalone-source');
  return PLAYER_BUNDLE;
}

/** Run the HTML export branch — handles all four htmlStyle × htmlBundle combinations. */
async function runHtmlExport(
  markdown: string,
  htmlFilename: string,
  options: ExportOptions,
  mediaContainer?: ContentContainer | null,
  selectedFile?: string | null,
  saveBlob?: ExportBlobSaver,
): Promise<void> {
  const baseName = htmlFilename.replace(/\.html$/, '');
  const zipName = `${baseName}.zip`;
  // When `entryAsIndex` is on, a single-doc HTML download lands on
  // disk as `index.html` so it drops straight into a static host. The
  // recursive ZIP path doesn't care — squisq's bundle helpers handle
  // the inside-zip rename and the cross-doc link rewrite themselves.
  const singleHtmlFilename = options.entryAsIndex ? 'index.html' : htmlFilename;
  const themeId = exporterThemeId(markdown, options.themeId);

  // Recursive HTML bundle: when the user opted in, ask squisq to walk
  // this doc's relative .md links and emit a ZIP with every reachable
  // page rendered + cross-doc hrefs rewritten. Two pipelines:
  //   • Plain  → `markdownDocsToPlainHtmlBundle` (semantic HTML)
  //   • Rendered → `markdownDocsToHtmlBundle` (SquisqPlayer-rendered,
  //                shared `squisq-player.js`, Doc-tree link rewrites)
  // Both consume the workspace container to resolve sibling files —
  // `mediaContainer` is already scoped to the selected file's parent
  // dir, which is exactly the bundle's scope root. Falls back to the
  // single-doc path if either prerequisite is missing rather than
  // silently skipping the recursion.
  if (options.includeLinkedDocs && mediaContainer && selectedFile) {
    const entryPath = basenameForBundle(selectedFile);
    const readDocument = (path: string) =>
      path === entryPath
        ? Promise.resolve(markdown)
        : readDocumentFromContainer(mediaContainer, path);
    if (options.htmlStyle === 'rendered') {
      // Linked pages are read lazily by the bundler, so the entry page decides
      // the player; one shared player script serves every page in the bundle.
      const [{ markdownDocsToHtmlBundle }, playerScript] = await Promise.all([
        import('@bendyline/squisq-formats/html'),
        playerScriptFor(markdown),
      ]);
      const blob = await markdownDocsToHtmlBundle({
        entryPath,
        readDocument,
        readBinary: (path) => mediaContainer.readFile(path),
        playerScript,
        title: baseName,
        themeId,
        mode: 'static',
        showCodeCopyButton: true,
        entryAsIndex: options.entryAsIndex,
      });
      await saveExportBlob(blob, zipName, saveBlob);
      return;
    }
    const { markdownDocsToPlainHtmlBundle } = await import('@bendyline/squisq-formats/html');
    const blob = await markdownDocsToPlainHtmlBundle({
      entryPath,
      readDocument,
      readBinary: (path) => mediaContainer.readFile(path),
      title: baseName,
      themeId,
      entryAsIndex: options.entryAsIndex,
    });
    await saveExportBlob(blob, zipName, saveBlob);
    return;
  }

  if (options.htmlStyle === 'rendered') {
    const [{ markdownToDoc }, { docToHtml, docToHtmlZip, collectImagePaths }, playerScript] =
      await Promise.all([
        import('@bendyline/squisq/doc'),
        import('@bendyline/squisq-formats/html'),
        playerScriptFor(markdown),
      ]);
    const mdDoc = parseMarkdown(markdown);
    const baseDoc = markdownToDoc(mdDoc);
    if (themeId) baseDoc.themeId = themeId;

    const images = mediaContainer
      ? await resolveDocImages(baseDoc, mediaContainer, collectImagePaths)
      : undefined;

    if (options.htmlBundle === 'zip') {
      const blob = await docToHtmlZip(baseDoc, {
        playerScript,
        images,
        mode: 'static',
        title: baseName,
        showCodeCopyButton: true,
      });
      await saveExportBlob(blob, zipName, saveBlob);
      return;
    }

    const html = docToHtml(baseDoc, {
      playerScript,
      images,
      mode: 'static',
      title: baseName,
      showCodeCopyButton: true,
    });
    await saveExportBlob(new Blob([html], { type: MIME_TYPES.html }), singleHtmlFilename, saveBlob);
    return;
  }

  // Plain semantic HTML
  const mdDoc = parseMarkdown(markdown);
  const referencedImages = collectMarkdownImageUrls(mdDoc);
  const localImages = referencedImages.filter((u) => !isExternalUrl(u));

  if (options.htmlBundle === 'zip' && mediaContainer && localImages.length > 0) {
    const [{ markdownDocToPlainHtml }, { MemoryContentContainer }, { containerToZip }] =
      await Promise.all([
        import('@bendyline/squisq-formats/html'),
        import('@bendyline/squisq/storage'),
        import('@bendyline/squisq-formats/container'),
      ]);
    // Mirror the markdown's relative paths inside the zip so <img src="..."> still resolves.
    const html = markdownDocToPlainHtml(mdDoc, { title: baseName, themeId });
    const container = new MemoryContentContainer();
    await container.writeFile('index.html', new TextEncoder().encode(html));
    for (const url of localImages) {
      const data = await mediaContainer.readFile(url);
      if (!data) continue;
      const cleanPath = url.replace(/^\/+/, '');
      await container.writeFile(cleanPath, new Uint8Array(data));
    }
    const blob = await containerToZip(container);
    await saveExportBlob(blob, zipName, saveBlob);
    return;
  }

  const { markdownDocToPlainHtml } = await import('@bendyline/squisq-formats/html');
  // Single-file plain HTML — embed local images as base64 data URIs.
  const inlineMap = new Map<string, string>();
  if (mediaContainer) {
    for (const url of localImages) {
      const data = await mediaContainer.readFile(url);
      if (!data) continue;
      inlineMap.set(url, arrayBufferToDataUrl(data, url));
    }
  }
  const html = markdownDocToPlainHtml(mdDoc, {
    title: baseName,
    images: inlineMap.size > 0 ? inlineMap : undefined,
    themeId,
  });
  await saveExportBlob(new Blob([html], { type: MIME_TYPES.html }), singleHtmlFilename, saveBlob);
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

function isExternalUrl(url: string): boolean {
  return (
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('data:') ||
    url.startsWith('blob:')
  );
}

function arrayBufferToDataUrl(data: ArrayBuffer, url: string): string {
  const ext = url.slice(url.lastIndexOf('.') + 1).toLowerCase();
  const mime = IMAGE_MIME[ext] ?? 'application/octet-stream';
  // btoa requires a binary string; chunk to avoid call-stack issues on large files.
  const bytes = new Uint8Array(data);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Walk the markdown AST and collect all image URLs. */
function collectMarkdownImageUrls(doc: MarkdownDocument): string[] {
  const urls: string[] = [];
  function walkBlocks(nodes: MarkdownBlockNode[]): void {
    for (const node of nodes) {
      if ('children' in node && Array.isArray(node.children)) {
        for (const child of node.children as (MarkdownBlockNode | MarkdownInlineNode)[]) {
          if (child.type === 'image') {
            urls.push((child as { url: string }).url);
          } else if ('children' in child && Array.isArray(child.children)) {
            walkBlocks(child.children as MarkdownBlockNode[]);
          }
        }
      }
    }
  }
  walkBlocks(doc.children);
  return Array.from(new Set(urls));
}

/** An image's bytes in the shape the DOCX and PDF exporters take. */
interface ExportImage {
  data: ArrayBuffer | Uint8Array;
  contentType: string;
  width?: number;
  height?: number;
}

/**
 * Resolve image URLs (markdown → docx, pdf) to binary data from a
 * ContentContainer. Empty when there is no container to read from.
 */
async function resolveImages(
  doc: MarkdownDocument,
  container: ContentContainer | null | undefined,
): Promise<Map<string, ExportImage>> {
  const map = new Map<string, ExportImage>();
  if (!container) return map;
  const urls = collectMarkdownImageUrls(doc);

  for (const url of urls) {
    if (map.has(url)) continue;
    if (isExternalUrl(url)) continue;
    const data = await container.readFile(url);
    if (!data) continue;
    const ext = url.slice(url.lastIndexOf('.') + 1).toLowerCase();
    const contentType = IMAGE_MIME[ext] || 'image/png';
    map.set(url, { data, contentType });
  }

  return map;
}

/**
 * Images for PDF, which draws PNG and JPEG only: an SVG with a picture goes
 * in as that PNG; one without still prints its alt text.
 */
function withSvgPictures(
  images: ReadonlyMap<string, ExportImage>,
  pictures: ReadonlyMap<string, DiagramPicture>,
): Map<string, ExportImage> {
  const result = new Map<string, ExportImage>();
  for (const [url, image] of images) {
    const picture = isSvgImageSource(url)
      ? pictures.get(svgSourceFromBytes(image.data).trim())
      : undefined;
    result.set(
      url,
      picture
        ? {
            data: picture.data,
            contentType: 'image/png',
            width: picture.width,
            height: picture.height,
          }
        : image,
    );
  }
  return result;
}

/** Resolve the raw image payload shape consumed by EPUB export. */
async function resolveImageData(
  doc: MarkdownDocument,
  container: ContentContainer,
): Promise<Map<string, ArrayBuffer>> {
  const urls = collectMarkdownImageUrls(doc);
  const map = new Map<string, ArrayBuffer>();

  for (const url of urls) {
    if (map.has(url) || isExternalUrl(url)) continue;
    const data = await container.readFile(url);
    if (data) map.set(url, data);
  }

  return map;
}

/** Container-relative path for the bundle's entry document. `mediaContainer`
 *  is already scoped to the selected file's parent directory, so the bundle
 *  needs the basename ("docs/home.md" → "home.md"). */
function basenameForBundle(selectedFile: string): string {
  const clean = selectedFile.replace(/^\/+/, '');
  const idx = clean.lastIndexOf('/');
  return idx === -1 ? clean : clean.slice(idx + 1);
}

/** Read a UTF-8 text document from a ContentContainer. Returns null when
 *  the file is missing — preserves the bundle's "abort with error" contract
 *  for unreachable .md links. */
async function readDocumentFromContainer(
  container: ContentContainer,
  path: string,
): Promise<string | null> {
  const data = await container.readFile(path);
  if (!data) return null;
  return new TextDecoder('utf-8').decode(data);
}

/** Resolve image paths referenced by a squisq Doc to ArrayBuffers for HTML export. */
async function resolveDocImages(
  doc: Doc,
  container: ContentContainer,
  collectImagePaths: (doc: Doc) => Iterable<string>,
): Promise<Map<string, ArrayBuffer>> {
  const paths = collectImagePaths(doc);
  const map = new Map<string, ArrayBuffer>();
  for (const path of paths) {
    const data = await container.readFile(path);
    if (!data) continue;
    map.set(path, data);
  }
  return map;
}
