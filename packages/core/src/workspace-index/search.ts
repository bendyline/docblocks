/**
 * Literal workspace search over indexed text: exact matches, optional case
 * and whole-word constraints, line snippets with highlight ranges.
 */

import type { SearchText } from './search-text.js';
import {
  WORKSPACE_SEARCH_LIMITS,
  type IndexedDocument,
  type WorkspaceSearchDocument,
  type WorkspaceSearchLimits,
  type WorkspaceSearchLineMatch,
  type WorkspaceSearchQuery,
  type WorkspaceSearchRange,
  type WorkspaceSearchResult,
} from './types.js';

/** Cooperative scheduling: yields between slices and honours aborts. */
export interface Checkpoint {
  (): Promise<void>;
}

export function createCheckpoint(
  yieldControl: () => Promise<void>,
  now: () => number,
  signal: AbortSignal | undefined,
  sliceMs = 8,
): Checkpoint {
  let sliceStart = now();
  return async () => {
    signal?.throwIfAborted();
    if (now() - sliceStart < sliceMs) return;
    await yieldControl();
    signal?.throwIfAborted();
    sliceStart = now();
  };
}

// Only these characters need escaping under the `u` flag; escaping anything
// else (`-`, for instance) is a syntax error there.
const REGEX_SYNTAX = /[\\^$.*+?()[\]{}|/]/gu;
const WORD_CHARACTER = /^[\p{L}\p{N}\p{M}_]$/u;

/**
 * Compile a query, or null when it cannot match anything (empty or too long).
 * Whole word only constrains the query's ends that are themselves word
 * characters, so `c++` still matches before a space.
 */
export function buildLiteralMatcher(
  query: WorkspaceSearchQuery,
  maxQueryCharacters: number = WORKSPACE_SEARCH_LIMITS.maxQueryCharacters,
): RegExp | null {
  const text = query.text.normalize('NFC');
  if (!text.trim() || text.length > maxQueryCharacters) return null;
  let source = text.replace(REGEX_SYNTAX, '\\$&');
  if (query.wholeWord) {
    const characters = [...text];
    if (WORD_CHARACTER.test(characters[0]!)) source = `(?<![\\p{L}\\p{N}\\p{M}_])${source}`;
    if (WORD_CHARACTER.test(characters[characters.length - 1]!)) {
      source = `${source}(?![\\p{L}\\p{N}\\p{M}_])`;
    }
  }
  return new RegExp(source, query.matchCase ? 'gu' : 'giu');
}

function rangesIn(matcher: RegExp, text: string): WorkspaceSearchRange[] {
  const ranges: WorkspaceSearchRange[] = [];
  for (const match of text.matchAll(matcher)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function countIn(matcher: RegExp, text: string, cap: number): number {
  let count = 0;
  for (const _match of text.matchAll(matcher)) {
    count += 1;
    if (count >= cap) break;
  }
  return count;
}

const SNIPPET_CHARACTERS = 200;
const SNIPPET_LEAD = 60;

/** A display line around its matches, with the ranges shifted to fit. */
export function buildSnippet(
  line: string,
  ranges: readonly WorkspaceSearchRange[],
): { readonly snippet: string; readonly ranges: readonly WorkspaceSearchRange[] } {
  if (line.length <= SNIPPET_CHARACTERS) {
    const indent = line.length - line.trimStart().length;
    return {
      snippet: line.slice(indent),
      ranges: ranges.map(([start, end]) => [start - indent, end - indent] as const),
    };
  }
  const first = ranges[0]?.[0] ?? 0;
  const start = Math.max(0, Math.min(first - SNIPPET_LEAD, line.length - SNIPPET_CHARACTERS));
  const end = Math.min(line.length, start + SNIPPET_CHARACTERS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < line.length ? '…' : '';
  const shift = prefix.length - start;
  const clipped: WorkspaceSearchRange[] = [];
  for (const [rangeStart, rangeEnd] of ranges) {
    if (rangeEnd <= start || rangeStart >= end) continue;
    clipped.push([Math.max(rangeStart, start) + shift, Math.min(rangeEnd, end) + shift]);
  }
  return { snippet: `${prefix}${line.slice(start, end)}${suffix}`, ranges: clipped };
}

export interface SearchableDocument {
  readonly record: IndexedDocument;
  readonly text: SearchText | null;
  /** Analysis still queued: content not searched yet. */
  readonly pending: boolean;
}

function stemOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface Tally {
  readonly document: SearchableDocument;
  readonly titleMatch: boolean;
  readonly titleRanges: readonly WorkspaceSearchRange[];
  readonly matchCount: number;
}

export async function searchDocuments(
  documents: readonly SearchableDocument[],
  query: WorkspaceSearchQuery,
  checkpoint: Checkpoint,
  limitOverrides: Partial<WorkspaceSearchLimits> = {},
): Promise<WorkspaceSearchResult> {
  const limits = { ...WORKSPACE_SEARCH_LIMITS, ...limitOverrides };
  const matcher = buildLiteralMatcher(query, limits.maxQueryCharacters);
  let pendingDocuments = 0;
  let skippedDocuments = 0;
  for (const document of documents) {
    if (document.pending) pendingDocuments += 1;
    else if (!document.text) skippedDocuments += 1;
  }
  if (!matcher) {
    return {
      documents: [],
      totalDocuments: 0,
      totalMatches: 0,
      truncated: false,
      pendingDocuments,
      skippedDocuments,
    };
  }

  // Pass 1: count matches everywhere, so the ranking sees every document.
  const tallies: Tally[] = [];
  let totalMatches = 0;
  let truncated = false;
  for (const document of documents) {
    await checkpoint();
    const titleRanges = rangesIn(matcher, document.record.title.normalize('NFC'));
    // A file-name hit ranks like a title hit; there is just nothing to highlight.
    const titleMatch =
      titleRanges.length > 0 ||
      countIn(matcher, stemOf(document.record.path).normalize('NFC'), 1) > 0;
    let matchCount = 0;
    if (document.text && !truncated) {
      for (const line of document.text.lines) {
        const room = Math.min(
          limits.maxMatchesPerDocument - matchCount,
          limits.maxTotalMatches - totalMatches - matchCount,
        );
        if (room <= 0) break;
        matchCount += countIn(matcher, line, room);
      }
      if (matchCount >= limits.maxMatchesPerDocument) truncated = true;
      totalMatches += matchCount;
      if (totalMatches >= limits.maxTotalMatches) truncated = true;
    }
    if (titleMatch || matchCount > 0) {
      tallies.push({ document, titleMatch, titleRanges, matchCount });
    }
  }

  tallies.sort(
    (left, right) =>
      Number(right.titleMatch) - Number(left.titleMatch) ||
      right.matchCount - left.matchCount ||
      compareCodeUnits(right.document.record.lastModified, left.document.record.lastModified) ||
      compareCodeUnits(left.document.record.path, right.document.record.path),
  );
  if (tallies.length > limits.maxDocuments) truncated = true;

  // Pass 2: snippets only for what will be shown.
  const results: WorkspaceSearchDocument[] = [];
  for (const tally of tallies.slice(0, limits.maxDocuments)) {
    await checkpoint();
    const { document } = tally;
    const matches: WorkspaceSearchLineMatch[] = [];
    let occurrence = 0;
    let moreMatches = false;
    const text = document.text;
    if (text && tally.matchCount > 0) {
      for (let index = 0; index < text.lines.length; index += 1) {
        const line = text.lines[index]!;
        const ranges = rangesIn(matcher, line);
        if (ranges.length === 0) continue;
        if (matches.length >= limits.maxLinesPerDocument) {
          moreMatches = true;
          break;
        }
        const snippet = buildSnippet(line, ranges);
        matches.push({
          line: text.sourceLines[index]!,
          kind: text.kinds[index]!,
          snippet: snippet.snippet,
          ranges: snippet.ranges,
          occurrence,
        });
        occurrence += ranges.length;
      }
    }
    results.push({
      path: document.record.path,
      title: document.record.title,
      format: document.record.format,
      titleMatch: tally.titleMatch,
      titleRanges: tally.titleRanges,
      matchCount: tally.matchCount,
      matches,
      moreMatches,
      lastModified: document.record.lastModified,
      pending: document.pending,
    });
  }

  return {
    documents: results,
    totalDocuments: tallies.length,
    totalMatches,
    truncated,
    pendingDocuments,
    skippedDocuments,
  };
}
