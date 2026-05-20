/**
 * Execute an export using @bendyline/squisq-formats.
 */

import type {
  MarkdownDocument,
  MarkdownBlockNode,
  MarkdownInlineNode,
} from '@bendyline/squisq/markdown';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { markdownToDoc } from '@bendyline/squisq/doc';
import type { Doc } from '@bendyline/squisq/schemas';
import { applyTransform } from '@bendyline/squisq/transform';
import { markdownDocToDocx } from '@bendyline/squisq-formats/docx';
import { markdownDocToPdf } from '@bendyline/squisq-formats/pdf';
import { docToPptx } from '@bendyline/squisq-formats/pptx';
import {
  docToHtml,
  docToHtmlZip,
  collectImagePaths,
  markdownDocsToPlainHtmlBundle,
  markdownDocsToHtmlBundle,
  markdownDocToPlainHtml,
} from '@bendyline/squisq-formats/html';
import { containerToZip } from '@bendyline/squisq-formats/container';
import { MemoryContentContainer } from '@bendyline/squisq/storage';
import { PLAYER_BUNDLE } from '@bendyline/squisq-react/standalone-source';
import type { ContentContainer } from '@bendyline/squisq/storage';
import type { ExportOptions, ExportFormat } from './export-options.js';
import { FORMAT_EXTENSIONS } from './export-options.js';

const MIME_TYPES: Record<ExportFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
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

/** Derive a filename from the selected file path and export format. */
function buildFilename(selectedFile: string | null, format: ExportFormat): string {
  const base = selectedFile ? selectedFile.replace(/^\//, '').replace(/\.[^.]+$/, '') : 'document';
  return base + FORMAT_EXTENSIONS[format];
}

/** Run the export and trigger a download. */
export async function runExport(
  markdown: string,
  selectedFile: string | null,
  options: ExportOptions,
  mediaContainer?: ContentContainer | null,
): Promise<void> {
  const filename = buildFilename(selectedFile, options.format);
  const themeId = options.themeId !== 'standard' ? options.themeId : undefined;

  if (options.format === 'md') {
    downloadBlob(new Blob([markdown], { type: MIME_TYPES.md }), filename);
    return;
  }

  if (options.format === 'html') {
    await runHtmlExport(markdown, filename, options, mediaContainer, selectedFile);
    return;
  }

  const doc = parseMarkdown(markdown);

  if (options.format === 'docx') {
    const images = mediaContainer ? await resolveImages(doc, mediaContainer) : undefined;
    const buf = await markdownDocToDocx(doc, { themeId, images });
    downloadBlob(new Blob([buf], { type: MIME_TYPES.docx }), filename);
    return;
  }

  if (options.format === 'pdf') {
    const buf = await markdownDocToPdf(doc, {
      themeId,
      pageSize: options.pageSize,
    });
    downloadBlob(new Blob([buf], { type: MIME_TYPES.pdf }), filename);
    return;
  }

  if (options.format === 'pptx') {
    // Use the full transform pipeline: markdown → Doc → transform → PPTX
    const baseDoc = markdownToDoc(doc);
    const transformed = applyTransform(baseDoc, options.transformStyle);
    const enrichedDoc = transformed.doc;
    if (themeId) {
      enrichedDoc.themeId = themeId;
    }
    const buf = await docToPptx(enrichedDoc, { themeId });
    downloadBlob(new Blob([buf], { type: MIME_TYPES.pptx }), filename);
    return;
  }
}

/** Run the HTML export branch — handles all four htmlStyle × htmlBundle combinations. */
async function runHtmlExport(
  markdown: string,
  htmlFilename: string,
  options: ExportOptions,
  mediaContainer?: ContentContainer | null,
  selectedFile?: string | null,
): Promise<void> {
  const baseName = htmlFilename.replace(/\.html$/, '');
  const zipName = `${baseName}.zip`;
  // When `entryAsIndex` is on, a single-doc HTML download lands on
  // disk as `index.html` so it drops straight into a static host. The
  // recursive ZIP path doesn't care — squisq's bundle helpers handle
  // the inside-zip rename and the cross-doc link rewrite themselves.
  const singleHtmlFilename = options.entryAsIndex ? 'index.html' : htmlFilename;
  const themeId = options.themeId !== 'standard' ? options.themeId : undefined;

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
    if (options.htmlStyle === 'rendered') {
      const blob = await markdownDocsToHtmlBundle({
        entryPath,
        readDocument: (path) => readDocumentFromContainer(mediaContainer, path),
        readBinary: (path) => mediaContainer.readFile(path),
        playerScript: PLAYER_BUNDLE,
        title: baseName,
        themeId,
        mode: 'static',
        entryAsIndex: options.entryAsIndex,
      });
      downloadBlob(blob, zipName);
      return;
    }
    const blob = await markdownDocsToPlainHtmlBundle({
      entryPath,
      readDocument: (path) => readDocumentFromContainer(mediaContainer, path),
      readBinary: (path) => mediaContainer.readFile(path),
      title: baseName,
      themeId,
      entryAsIndex: options.entryAsIndex,
    });
    downloadBlob(blob, zipName);
    return;
  }

  if (options.htmlStyle === 'rendered') {
    const mdDoc = parseMarkdown(markdown);
    const baseDoc = markdownToDoc(mdDoc);
    if (themeId) baseDoc.themeId = themeId;

    const images = mediaContainer ? await resolveDocImages(baseDoc, mediaContainer) : undefined;

    if (options.htmlBundle === 'zip') {
      const blob = await docToHtmlZip(baseDoc, {
        playerScript: PLAYER_BUNDLE,
        images,
        mode: 'static',
        title: baseName,
      });
      downloadBlob(blob, zipName);
      return;
    }

    const html = docToHtml(baseDoc, {
      playerScript: PLAYER_BUNDLE,
      images,
      mode: 'static',
      title: baseName,
    });
    downloadBlob(new Blob([html], { type: MIME_TYPES.html }), singleHtmlFilename);
    return;
  }

  // Plain semantic HTML
  const mdDoc = parseMarkdown(markdown);
  const referencedImages = collectMarkdownImageUrls(mdDoc);
  const localImages = referencedImages.filter((u) => !isExternalUrl(u));

  if (options.htmlBundle === 'zip' && mediaContainer && localImages.length > 0) {
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
    downloadBlob(blob, zipName);
    return;
  }

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
  downloadBlob(new Blob([html], { type: MIME_TYPES.html }), singleHtmlFilename);
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

/** Resolve image URLs (markdown → docx) to binary data from a ContentContainer. */
async function resolveImages(
  doc: MarkdownDocument,
  container: ContentContainer,
): Promise<Map<string, { data: ArrayBuffer | Uint8Array; contentType: string }>> {
  const urls = collectMarkdownImageUrls(doc);
  const map = new Map<string, { data: ArrayBuffer | Uint8Array; contentType: string }>();

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
