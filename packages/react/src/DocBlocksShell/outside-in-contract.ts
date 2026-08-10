/**
 * Compatibility host for Squisq's outside-in contract.
 *
 * The canonical API is `@bendyline/squisq-formats/outside-in`. DocBlocks keeps
 * only the synchronous path layout here; metadata and conversion operations
 * load the canonical implementation on demand so format runtimes stay behind
 * the outside-in document boundary.
 */

import type { MarkdownDocument } from '@bendyline/squisq/markdown';
import type { ContentContainer } from '@bendyline/squisq/storage';
import type { ConversionResult, ConvertOptions } from '@bendyline/squisq-formats/registry';

export const OUTSIDE_IN_FORMAT_IDS = ['html', 'docx', 'pdf', 'pptx', 'xlsx'] as const;
export type OutsideInFormatId = (typeof OUTSIDE_IN_FORMAT_IDS)[number];
const FORMAT_IDS = new Set<string>(OUTSIDE_IN_FORMAT_IDS);

export interface OutsideInLayout {
  targetPath: string;
  format: OutsideInFormatId;
  parentDirectory: string;
  stem: string;
  companionName: string;
  companionDirectory: string;
  markdownFilename: string;
  markdownPath: string;
  relativeTargetPath: string;
}

export interface OutsideInMetadata {
  version: 1;
  format: OutsideInFormatId;
  target: string;
}

function normalizePath(path: string): string {
  const leading = path.replace(/\\/g, '/').startsWith('/') ? '/' : '';
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`Outside-in paths must be canonical workspace paths: ${path}`);
  }
  return leading + parts.join('/');
}

function join(parent: string, child: string): string {
  if (!parent || parent === '/') return parent === '/' ? `/${child}` : child;
  return `${parent}/${child}`;
}

function slug(stem: string): string {
  return (
    stem
      .normalize('NFKD')
      .replace(/\p{Mark}+/gu, '')
      .toLocaleLowerCase('en-US')
      .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'document'
  );
}

export function resolveOutsideInLayout(path: string): OutsideInLayout | null {
  const targetPath = normalizePath(path);
  const slash = targetPath.lastIndexOf('/');
  const parentDirectory = slash < 0 ? '' : slash === 0 ? '/' : targetPath.slice(0, slash);
  const filename = slash < 0 ? targetPath : targetPath.slice(slash + 1);
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return null;
  const rawFormat = filename.slice(dot + 1).toLowerCase();
  const format = rawFormat === 'htm' ? 'html' : rawFormat;
  if (!FORMAT_IDS.has(format)) return null;
  const stem = filename.slice(0, dot);
  const companionName = `${stem}_files`;
  const companionDirectory = join(parentDirectory, companionName);
  const markdownFilename = `${slug(stem)}.md`;
  return {
    targetPath,
    format: format as OutsideInFormatId,
    parentDirectory,
    stem,
    companionName,
    companionDirectory,
    markdownFilename,
    markdownPath: join(companionDirectory, markdownFilename),
    relativeTargetPath: `../${filename}`,
  };
}

export function chooseOutsideInMarkdownPath(
  layout: OutsideInLayout,
  paths: readonly string[],
): string | null {
  const canonical = normalizePath(layout.markdownPath);
  const normalized = paths.map(normalizePath);
  const exact = normalized.find((path) => path === canonical);
  if (exact) return exact;
  const folded = normalized.find(
    (path) => path.toLocaleLowerCase('en-US') === canonical.toLocaleLowerCase('en-US'),
  );
  if (folded) return folded;
  const prefix = `${normalizePath(layout.companionDirectory).replace(/\/$/, '')}/`;
  const markdown = normalized.filter(
    (path) =>
      path.startsWith(prefix) &&
      !path.slice(prefix.length).includes('/') &&
      path.toLocaleLowerCase('en-US').endsWith('.md'),
  );
  return markdown.length === 1 ? markdown[0]! : null;
}

export async function readOutsideInMetadata(source: string): Promise<OutsideInMetadata | null> {
  const { readOutsideInMetadata: readMetadata } =
    await import('@bendyline/squisq-formats/outside-in');
  return readMetadata(source);
}

export async function withOutsideInMetadata(
  source: string,
  layout: OutsideInLayout,
): Promise<string> {
  const { withOutsideInMetadata: addMetadata } =
    await import('@bendyline/squisq-formats/outside-in');
  return addMetadata(source, layout);
}

export async function importOutsideInDocument(
  source: { data: ArrayBuffer | Uint8Array; targetPath: string },
  options: ConvertOptions = {},
): Promise<{ layout: OutsideInLayout; markdown: string; container: ContentContainer }> {
  const { importOutsideInDocument: importDocument } =
    await import('@bendyline/squisq-formats/outside-in');
  return importDocument(source, options);
}

export async function renderOutsideInDocument(
  source: { markdown: string | MarkdownDocument; targetPath: string; container?: ContentContainer },
  options: ConvertOptions & { html?: { playerScriptPath: string; basePath?: string } } = {},
): Promise<ConversionResult> {
  const { renderOutsideInDocument: renderDocument } =
    await import('@bendyline/squisq-formats/outside-in');
  return renderDocument(source, options);
}
