/**
 * Workspace catalog model — the data behind the generated catalog JSON and
 * catalog HTML page.
 *
 * Everything here is deterministic: identical inputs produce identical bytes
 * on every surface (shell, VS Code extension host, CLI). There are no
 * timestamps, no filesystem mtimes, and no locale-sensitive ordering, so a
 * catalog committed to git only changes when the documents do.
 */

import type {
  MarkdownBlockNode,
  MarkdownDocument,
  MarkdownInlineNode,
  MarkdownListItem,
} from '@bendyline/squisq/markdown';
import type { OutsideInFormatId } from './outside-in-layout.js';
import type { CatalogSortOrder } from './settings.js';

export const CATALOG_GENERATOR = 'docblocks-workspace-catalog';
export const CATALOG_FORMAT_VERSION = 1;

export const CATALOG_LIMITS = {
  maxOutlineEntries: 100,
  maxOutlineTitleCharacters: 256,
  maxExcerptCharacters: 280,
  maxDescriptionCharacters: 1024,
  maxMetadataCharacters: 256,
  maxTags: 32,
} as const;

export type CatalogDocumentFormat = 'markdown' | OutsideInFormatId;

export interface CatalogOutlineEntry {
  readonly level: number;
  readonly title: string;
}

export interface CatalogEntry {
  /** The document people open — the rendered file for outside-in documents. */
  readonly path: string;
  /** The Markdown source when it differs from `path` (outside-in companion). */
  readonly source?: string;
  readonly format: CatalogDocumentFormat;
  readonly title: string;
  readonly description?: string;
  readonly author?: string;
  readonly date?: string;
  readonly tags?: readonly string[];
  readonly theme?: string;
  readonly outline: readonly CatalogOutlineEntry[];
  readonly wordCount: number;
  readonly excerpt?: string;
  /** Present only when the catalog is configured with `content: "markdown"`. */
  readonly markdown?: string;
}

export interface WorkspaceCatalog {
  readonly generator: typeof CATALOG_GENERATOR;
  readonly version: typeof CATALOG_FORMAT_VERSION;
  readonly title: string;
  readonly documents: readonly CatalogEntry[];
}

export interface CatalogSource {
  readonly path: string;
  readonly source?: string;
  readonly format: CatalogDocumentFormat;
}

type MarkdownModule = typeof import('@bendyline/squisq/markdown');

let markdownModule: Promise<MarkdownModule> | null = null;
function loadMarkdown(): Promise<MarkdownModule> {
  markdownModule ??= import('@bendyline/squisq/markdown');
  return markdownModule;
}

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu;

function countWords(text: string): number {
  return text.match(WORD_PATTERN)?.length ?? 0;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  const slice = text.slice(0, maximum - 1);
  const space = slice.lastIndexOf(' ');
  return `${(space > maximum / 2 ? slice.slice(0, space) : slice).trimEnd()}…`;
}

function metadataText(value: unknown, maximum: number): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string') return undefined;
  const text = collapseWhitespace(value);
  return text ? truncate(text, maximum) : undefined;
}

function firstMetadataText(
  frontmatter: Record<string, unknown> | undefined,
  keys: readonly string[],
  maximum: number,
): string | undefined {
  for (const key of keys) {
    const value = metadataText(frontmatter?.[key], maximum);
    if (value) return value;
  }
  return undefined;
}

function metadataTags(frontmatter: Record<string, unknown> | undefined): string[] | undefined {
  const raw = frontmatter?.tags ?? frontmatter?.keywords;
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? // Squisq's frontmatter reader keeps YAML flow lists (`[a, b]`) as text.
        raw
          .replace(/^\s*\[|\]\s*$/g, '')
          .split(',')
          .map((tag) => tag.trim().replace(/^(["'])(.*)\1$/, '$2'))
      : [];
  const tags: string[] = [];
  for (const value of values) {
    const tag = metadataText(value, CATALOG_LIMITS.maxMetadataCharacters);
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= CATALOG_LIMITS.maxTags) break;
  }
  return tags.length > 0 ? tags : undefined;
}

function stemOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export interface CatalogEntryHints {
  /** Title used when the document has neither a frontmatter title nor a heading. */
  readonly fallbackTitle?: string;
  readonly description?: string;
}

/** Build a catalog entry from an already-parsed Markdown document. */
export async function catalogEntryFromDocument(
  source: CatalogSource,
  document: MarkdownDocument,
  hints: CatalogEntryHints = {},
): Promise<CatalogEntry> {
  const { extractPlainText, inferDocumentTitle, readFrontmatterThemeId } = await loadMarkdown();
  const frontmatter = document.frontmatter;
  const title =
    metadataText(inferDocumentTitle(document), CATALOG_LIMITS.maxMetadataCharacters) ??
    metadataText(hints.fallbackTitle, CATALOG_LIMITS.maxMetadataCharacters) ??
    stemOf(source.path);

  const outline: CatalogOutlineEntry[] = [];
  let words = 0;
  let excerpt: string | undefined;
  for (const block of document.children) {
    const text = extractPlainText(block);
    words += countWords(text);
    if (block.type === 'heading') {
      const headingTitle = collapseWhitespace(text);
      if (headingTitle && outline.length < CATALOG_LIMITS.maxOutlineEntries) {
        outline.push({
          level: block.depth,
          title: truncate(headingTitle, CATALOG_LIMITS.maxOutlineTitleCharacters),
        });
      }
    } else if (block.type === 'paragraph' && excerpt === undefined) {
      const paragraph = collapseWhitespace(text);
      // HTML imports surface `<title>` as a leading paragraph; never echo the title.
      if (paragraph && paragraph !== title && paragraph !== hints.fallbackTitle) {
        excerpt = truncate(paragraph, CATALOG_LIMITS.maxExcerptCharacters);
      }
    }
  }

  const description =
    firstMetadataText(
      frontmatter,
      ['description', 'summary', 'excerpt'],
      CATALOG_LIMITS.maxDescriptionCharacters,
    ) ?? metadataText(hints.description, CATALOG_LIMITS.maxDescriptionCharacters);
  const author = firstMetadataText(frontmatter, ['author'], CATALOG_LIMITS.maxMetadataCharacters);
  const date = firstMetadataText(
    frontmatter,
    ['date', 'updated', 'published'],
    CATALOG_LIMITS.maxMetadataCharacters,
  );
  const theme = readFrontmatterThemeId(frontmatter);

  return {
    path: source.path,
    ...(source.source !== undefined && source.source !== source.path
      ? { source: source.source }
      : {}),
    format: source.format,
    title,
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
    ...(date ? { date } : {}),
    ...(metadataTags(frontmatter) ? { tags: metadataTags(frontmatter) } : {}),
    ...(theme ? { theme } : {}),
    outline,
    wordCount: words,
    ...(excerpt ? { excerpt } : {}),
  };
}

/** Parse Markdown source and build its catalog entry. */
export async function catalogEntryFromMarkdown(
  source: CatalogSource,
  markdown: string,
  options: { readonly includeMarkdown?: boolean } = {},
): Promise<CatalogEntry> {
  const { parseMarkdown } = await loadMarkdown();
  const normalized = normalizeLineEndings(markdown);
  const entry = await catalogEntryFromDocument(source, parseMarkdown(normalized));
  return options.includeMarkdown ? { ...entry, markdown: normalized } : entry;
}

/** A document whose content cannot be read (e.g. an un-imported DOCX): listed by name only. */
export function catalogEntryForUnreadable(source: CatalogSource): CatalogEntry {
  return {
    path: source.path,
    format: source.format,
    title: stemOf(source.path),
    outline: [],
    wordCount: 0,
  };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortCatalogEntries(
  entries: readonly CatalogEntry[],
  order: CatalogSortOrder,
): CatalogEntry[] {
  const byPath = (left: CatalogEntry, right: CatalogEntry) =>
    compareCodeUnits(left.path, right.path);
  const byTitle = (left: CatalogEntry, right: CatalogEntry) =>
    compareCodeUnits(left.title.toLowerCase(), right.title.toLowerCase()) ||
    compareCodeUnits(left.title, right.title) ||
    byPath(left, right);
  return [...entries].sort((left, right) => {
    if (order === 'path') return byPath(left, right);
    if (order === 'date') {
      if (left.date && right.date) {
        return compareCodeUnits(right.date, left.date) || byTitle(left, right);
      }
      if (left.date) return -1;
      if (right.date) return 1;
    }
    return byTitle(left, right);
  });
}

export function createWorkspaceCatalog(
  title: string,
  entries: readonly CatalogEntry[],
  order: CatalogSortOrder,
): WorkspaceCatalog {
  return {
    generator: CATALOG_GENERATOR,
    version: CATALOG_FORMAT_VERSION,
    title,
    documents: sortCatalogEntries(entries, order),
  };
}

function orderedEntry(entry: CatalogEntry): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  const keys: readonly (keyof CatalogEntry)[] = [
    'path',
    'source',
    'format',
    'title',
    'description',
    'author',
    'date',
    'tags',
    'theme',
    'outline',
    'wordCount',
    'excerpt',
    'markdown',
  ];
  for (const key of keys) {
    const value = entry[key];
    if (value === undefined) continue;
    ordered[key] =
      key === 'outline'
        ? (value as readonly CatalogOutlineEntry[]).map((item) => ({
            level: item.level,
            title: item.title,
          }))
        : value;
  }
  return ordered;
}

/**
 * Deterministic catalog JSON. The fixed leading `"generator"` key doubles as
 * the marker that lets DocBlocks recognize — and only ever replace — a file
 * it generated.
 */
export function serializeCatalogJson(catalog: WorkspaceCatalog): string {
  return `${JSON.stringify(
    {
      generator: catalog.generator,
      version: catalog.version,
      title: catalog.title,
      documents: catalog.documents.map(orderedEntry),
    },
    null,
    2,
  )}\n`;
}

const CATALOG_JSON_MARKER = /^\uFEFF?\{\s*"generator"\s*:\s*"docblocks-workspace-catalog"/;

export function isGeneratedCatalogJson(text: string): boolean {
  return CATALOG_JSON_MARKER.test(text.slice(0, 256));
}

const CATALOG_HTML_MARKER = /<!-- docblocks-workspace-catalog v1 inputs=sha256:([0-9a-f]{64}) -->/;
const CATALOG_HTML_MARKER_SCAN_CHARACTERS = 2048;

/** Insert the generator marker directly after the doctype so it cannot affect quirks mode. */
export function stampCatalogHtml(html: string, inputsDigest: string): string {
  if (!/^[0-9a-f]{64}$/.test(inputsDigest)) throw new Error('Catalog digest must be SHA-256 hex.');
  const marker = `<!-- ${CATALOG_GENERATOR} v1 inputs=sha256:${inputsDigest} -->\n`;
  const doctype = /^<!DOCTYPE html>\r?\n/i.exec(html);
  return doctype ? `${doctype[0]}${marker}${html.slice(doctype[0].length)}` : `${marker}${html}`;
}

export function readCatalogHtmlDigest(text: string): string | null {
  return CATALOG_HTML_MARKER.exec(text.slice(0, CATALOG_HTML_MARKER_SCAN_CHARACTERS))?.[1] ?? null;
}

export function isGeneratedCatalogHtml(text: string): boolean {
  return readCatalogHtmlDigest(text) !== null;
}

/** Relative, per-segment-encoded URL from the catalog's directory to a document. */
export function relativeCatalogLink(fromDirectory: string, toPath: string): string {
  const from = fromDirectory.split('/').filter(Boolean);
  const to = toPath.split('/').filter(Boolean);
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1;
  const up = from.slice(shared).map(() => '..');
  return [...up, ...to.slice(shared).map((segment) => encodeURIComponent(segment))].join('/');
}

function textNode(value: string): MarkdownInlineNode {
  return { type: 'text', value };
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/**
 * Build the catalog page as a Markdown AST rather than Markdown text, so a
 * document title or description can never inject Markdown or HTML: every
 * value reaches the renderer as an escaped text node.
 */
export function buildCatalogMarkdownDocument(
  catalog: WorkspaceCatalog,
  outputPath: string,
): MarkdownDocument {
  const outputDirectory = folderOf(outputPath);
  const children: MarkdownBlockNode[] = [
    { type: 'heading', depth: 1, children: [textNode(catalog.title)] },
  ];
  if (catalog.documents.length === 0) {
    children.push({ type: 'paragraph', children: [textNode('No documents yet.')] });
    return { type: 'document', children };
  }

  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of catalog.documents) {
    const folder = folderOf(entry.path);
    const group = groups.get(folder);
    if (group) group.push(entry);
    else groups.set(folder, [entry]);
  }
  const folders = [...groups.keys()].sort(compareCodeUnits);
  const showFolders = folders.length > 1 || folders[0] !== '';

  for (const folder of folders) {
    if (showFolders && folder) {
      children.push({ type: 'heading', depth: 2, children: [textNode(folder)] });
    }
    const items: MarkdownListItem[] = groups.get(folder)!.map((entry) => {
      const inline: MarkdownInlineNode[] = [
        {
          type: 'link',
          url: relativeCatalogLink(outputDirectory, entry.path),
          title: null,
          children: [textNode(entry.title)],
        },
      ];
      if (entry.date) inline.push(textNode(` · ${entry.date}`));
      const description = entry.description ?? entry.excerpt;
      if (description) inline.push(textNode(` — ${description}`));
      return {
        type: 'listItem',
        spread: false,
        children: [{ type: 'paragraph', children: inline }],
      };
    });
    children.push({ type: 'list', ordered: false, spread: false, children: items });
  }
  return { type: 'document', children };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
