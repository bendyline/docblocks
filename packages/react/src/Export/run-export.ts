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
import { applyTransform } from '@bendyline/squisq/transform';
import { markdownDocToDocx } from '@bendyline/squisq-formats/docx';
import { markdownDocToPdf } from '@bendyline/squisq-formats/pdf';
import { docToPptx } from '@bendyline/squisq-formats/pptx';
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
    const html = wrapMarkdownAsHtml(markdown);
    downloadBlob(new Blob([html], { type: MIME_TYPES.html }), filename);
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

/** Wrap raw markdown in a basic styled HTML page. */
function wrapMarkdownAsHtml(markdown: string): string {
  // Convert markdown to simple HTML via the parser
  const doc = parseMarkdown(markdown);
  // Build a minimal representation from the parsed nodes
  const lines: string[] = [];
  for (const node of doc.children) {
    lines.push(nodeToHtml(node));
  }
  const body = lines.join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Document</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 2em auto; padding: 0 1em; line-height: 1.6; color: #1f2937; }
  h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; }
  pre { background: #f3f4f6; padding: 1em; border-radius: 4px; overflow-x: auto; }
  code { background: #f3f4f6; padding: 0.15em 0.3em; border-radius: 3px; font-size: 0.9em; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #d1d5db; margin-left: 0; padding-left: 1em; color: #6b7280; }
  img { max-width: 100%; }
  a { color: #3b82f6; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** Convert a markdown AST node to HTML (basic). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nodeToHtml(node: any): string {
  if (!node) return '';
  switch (node.type) {
    case 'heading': {
      const tag = `h${node.depth ?? 1}`;
      return `<${tag}>${childrenToHtml(node)}</${tag}>`;
    }
    case 'paragraph':
      return `<p>${childrenToHtml(node)}</p>`;
    case 'text':
      return escapeHtml(node.value ?? '');
    case 'strong':
      return `<strong>${childrenToHtml(node)}</strong>`;
    case 'emphasis':
      return `<em>${childrenToHtml(node)}</em>`;
    case 'delete':
      return `<del>${childrenToHtml(node)}</del>`;
    case 'inlineCode':
      return `<code>${escapeHtml(node.value ?? '')}</code>`;
    case 'code':
      return `<pre><code>${escapeHtml(node.value ?? '')}</code></pre>`;
    case 'blockquote':
      return `<blockquote>${childrenToHtml(node)}</blockquote>`;
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      return `<${tag}>${childrenToHtml(node)}</${tag}>`;
    }
    case 'listItem':
      return `<li>${childrenToHtml(node)}</li>`;
    case 'link':
      return `<a href="${escapeAttr(node.url ?? '')}">${childrenToHtml(node)}</a>`;
    case 'image':
      return `<img src="${escapeAttr(node.url ?? '')}" alt="${escapeAttr(node.alt ?? '')}" />`;
    case 'thematicBreak':
      return '<hr />';
    default:
      return node.children ? childrenToHtml(node) : escapeHtml(node.value ?? '');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function childrenToHtml(node: any): string {
  if (!node.children) return node.value ? escapeHtml(node.value) : '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return node.children.map((c: any) => nodeToHtml(c)).join('');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

/** Walk the markdown AST and collect all image URLs. */
function collectImageUrls(doc: MarkdownDocument): string[] {
  const urls: string[] = [];
  function walkBlocks(nodes: MarkdownBlockNode[]): void {
    for (const node of nodes) {
      if ('children' in node && Array.isArray(node.children)) {
        // Check if children are inline or block nodes
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
  return urls;
}

/** Resolve image URLs to binary data from a ContentContainer. */
async function resolveImages(
  doc: MarkdownDocument,
  container: ContentContainer,
): Promise<Map<string, { data: ArrayBuffer | Uint8Array; contentType: string }>> {
  const urls = collectImageUrls(doc);
  const map = new Map<string, { data: ArrayBuffer | Uint8Array; contentType: string }>();

  for (const url of urls) {
    if (map.has(url)) continue;
    // Skip external URLs
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:'))
      continue;
    const data = await container.readFile(url);
    if (!data) continue;
    const ext = url.slice(url.lastIndexOf('.') + 1).toLowerCase();
    const contentType = IMAGE_MIME[ext] || 'image/png';
    map.set(url, { data, contentType });
  }

  return map;
}
