/**
 * Turn one document's bytes into an index record plus searchable text.
 * Pure apart from lazily loading Squisq's Markdown parser.
 */

import { FsError } from '../filesystem/fs-error.js';
import { decodeUtf8Text } from '../filesystem/utf8.js';
import type { WorkspacePath } from '../filesystem/workspace-path.js';
import {
  catalogEntryFromDocument,
  normalizeLineEndings,
  type CatalogDocumentFormat,
} from '../workspace-settings/catalog.js';
import { extractSearchText, lineSearchText, type SearchText } from './search-text.js';
import type { IndexedDocument, IndexedDocumentIssue } from './types.js';

type MarkdownModule = typeof import('@bendyline/squisq/markdown');

let markdownModule: Promise<MarkdownModule> | null = null;
function loadMarkdown(): Promise<MarkdownModule> {
  markdownModule ??= import('@bendyline/squisq/markdown');
  return markdownModule;
}

export interface DocumentIdentity {
  readonly path: WorkspacePath;
  readonly sourcePath: WorkspacePath | null;
  readonly format: CatalogDocumentFormat;
  readonly lastModified: string;
}

export interface AnalyzedDocument {
  readonly record: IndexedDocument;
  readonly text: SearchText | null;
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

function linesDocument(
  identity: DocumentIdentity,
  source: string,
  issue: IndexedDocumentIssue,
): AnalyzedDocument {
  const text = lineSearchText(source);
  const heading = text.lines.map((line) => ATX_HEADING.exec(line)?.[1]).find(Boolean);
  return {
    record: {
      path: identity.path,
      sourcePath: identity.sourcePath,
      format: identity.format,
      lastModified: identity.lastModified,
      title: heading ?? stemOf(identity.path),
      outline: [],
      wordCount: 0,
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

  const { MarkdownLimitError, parseMarkdown } = await loadMarkdown();
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
      content: 'full',
    },
    text: extractSearchText(document, source),
  };
}
