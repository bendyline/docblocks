/**
 * Turn one document's bytes into an index record plus searchable text.
 * Pure apart from lazily loading Squisq's Markdown parser.
 */

import { FsError } from '../filesystem/fs-error.js';
import { decodeUtf8Text } from '../filesystem/utf8.js';
import type { WorkspacePath } from '../filesystem/workspace-path.js';
import {
  countChecklist,
  countChecklistLines,
  type ChecklistProgress,
} from '../properties/checklist.js';
import { readDocumentProperties } from '../properties/read.js';
import { DOCUMENT_PROPERTY_LIMITS } from '../properties/types.js';
import {
  catalogEntryFromDocument,
  normalizeLineEndings,
  type CatalogDocumentFormat,
} from '../workspace-settings/catalog.js';
import { extractSearchText, lineSearchText, type SearchText } from './search-text.js';
import { blankDroppedLines } from './content-source.js';
import type { IndexedDocument, IndexedDocumentIssue } from './types.js';

type MarkdownModule = typeof import('@bendyline/squisq/markdown');

let markdownModule: Promise<MarkdownModule> | null = null;
function loadMarkdown(): Promise<MarkdownModule> {
  markdownModule ??= import('@bendyline/squisq/markdown');
  return markdownModule;
}

/**
 * Bumped when analysis learns something new from the same bytes (revision 2
 * added document properties and checklist progress). A persistent engine
 * records the revision with each document, so records an earlier version of
 * the app stored are brought up to date instead of being trusted as they are.
 */
export const DOCUMENT_ANALYZER_REVISION = 3;

export interface DocumentIdentity {
  readonly path: WorkspacePath;
  readonly sourcePath: WorkspacePath | null;
  readonly format: CatalogDocumentFormat;
  readonly lastModified: string;
}

export interface AnalyzedDocument {
  readonly record: IndexedDocument;
  readonly text: SearchText | null;
  /**
   * The text to keep for passages, when it is not the file as read: side
   * information kept in the document blanked out (see `content-source.ts`).
   */
  readonly body?: string;
}

function stemOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** A document known by name only: not read yet, or not readable as text. */
export function nameOnlyDocument(
  identity: DocumentIdentity,
  issue: IndexedDocumentIssue,
): AnalyzedDocument {
  return {
    record: {
      path: identity.path,
      sourcePath: identity.sourcePath,
      format: identity.format,
      lastModified: identity.lastModified,
      title: stemOf(identity.path),
      outline: [],
      wordCount: 0,
      content: 'name-only',
      issue,
    },
    text: null,
  };
}

const ATX_HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u;

type PropertyFields = Pick<
  IndexedDocument,
  'due' | 'category' | 'repeat' | 'completed' | 'checklist'
>;

/** The record fields that come from frontmatter properties and checklist lines. */
function propertyFields(
  frontmatter: Readonly<Record<string, unknown>> | undefined,
  checklist: ChecklistProgress | undefined,
): PropertyFields {
  const properties = readDocumentProperties(frontmatter);
  return {
    ...(properties.due ? { due: properties.due } : {}),
    ...(properties.category ? { category: properties.category } : {}),
    ...(properties.repeat ? { repeat: properties.repeat } : {}),
    ...(properties.completed !== undefined ? { completed: properties.completed } : {}),
    ...(checklist ? { checklist } : {}),
  };
}

/** Frontmatter of a document too large to parse whole, read from its opening block alone. */
async function leadingFrontmatter(source: string): Promise<Record<string, unknown> | undefined> {
  if (!source.startsWith('---')) return undefined;
  const { parseFrontmatter, splitFrontmatterBlock } = await loadMarkdown();
  const block = splitFrontmatterBlock(
    source.slice(0, DOCUMENT_PROPERTY_LIMITS.maxFrontmatterBytes),
  ).frontmatter;
  if (!block) return undefined;
  const firstBreak = block.indexOf('\n');
  if (firstBreak < 0) return undefined;
  try {
    return (
      parseFrontmatter(block.slice(firstBreak + 1).replace(/\r?\n---(?:\r?\n)?$/, '')) ?? undefined
    );
  } catch {
    return undefined;
  }
}

async function linesDocument(
  identity: DocumentIdentity,
  source: string,
  issue: IndexedDocumentIssue,
): Promise<AnalyzedDocument> {
  const text = lineSearchText(source);
  const heading = text.lines.map((line) => ATX_HEADING.exec(line)?.[1]).find(Boolean);
  const frontmatter = await leadingFrontmatter(source);
  return {
    record: {
      path: identity.path,
      sourcePath: identity.sourcePath,
      format: identity.format,
      lastModified: identity.lastModified,
      title: heading ?? stemOf(identity.path),
      outline: [],
      wordCount: 0,
      ...propertyFields(frontmatter, countChecklistLines(source)),
      content: 'lines',
      issue,
    },
    text,
  };
}

/** Analyze a document's Markdown bytes. Never throws for content problems. */
export async function analyzeDocumentBytes(
  identity: DocumentIdentity,
  data: ArrayBuffer,
  options: { readonly maxParseBytes: number; readonly signal?: AbortSignal },
): Promise<AnalyzedDocument> {
  let decoded: string;
  try {
    decoded = decodeUtf8Text(data, { path: identity.sourcePath ?? identity.path });
  } catch (error: unknown) {
    if (error instanceof FsError) return nameOnlyDocument(identity, 'not-utf8');
    throw error;
  }
  const source = normalizeLineEndings(decoded);
  if (data.byteLength > options.maxParseBytes) {
    return linesDocument(identity, source, 'parse-limit');
  }

  const { MarkdownLimitError, parseMarkdown, withoutAccessorySectionNodes } = await loadMarkdown();
  let document: ReturnType<MarkdownModule['parseMarkdown']>;
  try {
    document = parseMarkdown(source, {
      limits: { maxSourceBytes: options.maxParseBytes },
      signal: options.signal,
    });
  } catch (error: unknown) {
    if (error instanceof MarkdownLimitError) return linesDocument(identity, source, 'parse-limit');
    throw error;
  }

  // Side information kept in the document (slide summaries, study cards) is
  // not the person's writing: not counted as steps, not searched, not cited.
  const kept = withoutAccessorySectionNodes(document.children);
  const keptSet = new Set(kept);
  const content = kept === document.children ? document : { ...document, children: kept };
  const indexedSource = blankDroppedLines(
    source,
    document.children.filter((node) => !keptSet.has(node)),
  );
  const entry = await catalogEntryFromDocument(
    {
      path: identity.path,
      ...(identity.sourcePath && identity.sourcePath !== identity.path
        ? { source: identity.sourcePath }
        : {}),
      format: identity.format,
    },
    document,
  );
  return {
    record: {
      path: identity.path,
      sourcePath: identity.sourcePath,
      format: identity.format,
      lastModified: identity.lastModified,
      title: entry.title,
      outline: entry.outline,
      wordCount: entry.wordCount,
      ...(entry.excerpt ? { excerpt: entry.excerpt } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.tags ? { tags: entry.tags } : {}),
      ...propertyFields(document.frontmatter, countChecklist(content)),
      content: 'full',
    },
    text: extractSearchText(content, indexedSource),
    ...(indexedSource !== source ? { body: indexedSource } : {}),
  };
}
