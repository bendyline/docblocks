/**
 * Cut a document into pieces a small model can read, for study aids.
 *
 * The default model may have a 4,096-token context, so a long document is
 * read in parts. Sections stay whole where they fit, in document order; a
 * section too long for one part is split between paragraphs. When even the
 * most parts allowed cannot carry the document, every section is shortened
 * in proportion rather than dropping the end.
 */

import { extractPlainText, parseMarkdown } from '@bendyline/squisq/markdown';
import { clipPassage } from './illustrate-passages.js';

export interface StudyBudget {
  readonly contextTokens: number;
  /** Characters of document text one call carries. */
  readonly chunkCharacters: number;
  /** Most parts a document is read in; longer documents are shortened. */
  readonly maxChunks: number;
  /** Output tokens for the notes on one part of a long document. */
  readonly notesTokens: number;
  /** Output tokens for the finished summary. */
  readonly summaryTokens: number;
  /** Output tokens for one call that writes quiz questions or flashcards. */
  readonly itemTokens: number;
  /** Most questions or cards one call is asked for. */
  readonly itemsPerCall: number;
}

/** Characters per token, deliberately low so prompts never overrun the window. */
const CHARACTERS_PER_TOKEN = 3;
const SYSTEM_TOKENS = 450;
const SAFETY_TOKENS = 150;
const SMALL_CONTEXT = 16_384;

/** Budgets for a model's context window; unknown windows are treated as 4K. */
export function studyBudget(contextWindow: number | null): StudyBudget {
  const contextTokens = contextWindow !== null && contextWindow > 0 ? contextWindow : 4_096;
  const small = contextTokens < SMALL_CONTEXT;
  // Apple's on-device model stops every reply at 1,024 tokens.
  const summaryTokens = small ? 700 : 1_500;
  const itemTokens = small ? 700 : 1_600;
  const inputTokens =
    contextTokens - Math.max(summaryTokens, itemTokens) - SYSTEM_TOKENS - SAFETY_TOKENS;
  return {
    contextTokens,
    chunkCharacters: Math.min(24_000, Math.max(1_200, inputTokens * CHARACTERS_PER_TOKEN)),
    maxChunks: small ? 6 : 10,
    notesTokens: small ? 320 : 700,
    summaryTokens,
    itemTokens,
    itemsPerCall: small ? 4 : 6,
  };
}

export interface StudySection {
  /** The section's heading as plain text; '' for text before the first heading. */
  readonly heading: string;
  /** The section's prose as plain text, one block per paragraph. */
  readonly text: string;
}

/** Blocks whose text is prose worth reading; code, HTML, and pictures are not. */
const PROSE_BLOCKS: ReadonlySet<string> = new Set([
  'paragraph',
  'list',
  'table',
  'blockquote',
  'definitionList',
]);

function plain(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** Every section of `source` that holds prose, in document order. */
export function segmentStudySections(source: string): StudySection[] {
  let children: ReturnType<typeof parseMarkdown>['children'];
  try {
    children = parseMarkdown(source).children;
  } catch {
    return [];
  }
  const sections: StudySection[] = [];
  let heading = '';
  let blocks: string[] = [];
  const flush = () => {
    if (blocks.length > 0) sections.push({ heading, text: blocks.join('\n\n') });
    blocks = [];
  };
  for (const node of children) {
    if (node.type === 'heading') {
      flush();
      heading = plain(extractPlainText(node));
      continue;
    }
    if (!PROSE_BLOCKS.has(node.type)) continue;
    const text = plain(extractPlainText(node));
    if (text) blocks.push(text);
  }
  flush();
  return sections;
}

/** Characters of prose in `sections`. */
export function studyCharacters(sections: readonly StudySection[]): number {
  return sections.reduce((total, section) => total + section.text.length, 0);
}

export interface StudyChunk {
  readonly index: number;
  /** The part as the model sees it: each section's heading, then its text. */
  readonly text: string;
}

export interface StudyChunking {
  readonly chunks: readonly StudyChunk[];
  /** True when sections were shortened to fit the most parts allowed. */
  readonly shortened: boolean;
}

function render(heading: string, text: string): string {
  return heading ? `## ${heading}\n${text}` : text;
}

/** `text` in runs no longer than `size`, split between sentences, then between words. */
function splitLong(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let current = '';
  for (const sentence of text.split(/(?<=[.!?])\s+|\n/u)) {
    let rest = sentence;
    while (rest.length > size) {
      if (current) {
        out.push(current);
        current = '';
      }
      const space = rest.lastIndexOf(' ', size);
      const cut = space > size / 2 ? space : size;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    if (current && current.length + 1 + rest.length > size) {
      out.push(current);
      current = '';
    }
    current = current ? `${current} ${rest}` : rest;
  }
  if (current) out.push(current);
  return out;
}

/** `section` as one or more pieces no longer than `max`, split between paragraphs. */
function pieces(section: StudySection, max: number): string[] {
  const whole = render(section.heading, section.text);
  if (whole.length <= max) return [whole];
  const continued = section.heading ? `${section.heading} (continued)` : '';
  // Room for the longest heading line a piece can carry.
  const size = Math.max(200, max - render(continued, '').length - 2);
  const out: string[] = [];
  let heading = section.heading;
  let current = '';
  for (const paragraph of section.text.split('\n\n').flatMap((text) => splitLong(text, size))) {
    if (current && current.length + 2 + paragraph.length > size) {
      out.push(render(heading, current));
      heading = continued;
      current = '';
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) out.push(render(heading, current));
  return out;
}

function pack(sections: readonly StudySection[], max: number): string[] {
  const parts: string[] = [];
  let current = '';
  for (const section of sections) {
    for (const piece of pieces(section, max)) {
      if (current && current.length + 2 + piece.length > max) {
        parts.push(current);
        current = '';
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** Shortest clipped section worth keeping; anything shorter is left out. */
const MIN_SECTION_CHARACTERS = 40;

/**
 * `sections` within `capacity` characters: each section's text gets a share
 * of what the headings leave, in proportion to its length.
 */
function shorten(sections: readonly StudySection[], capacity: number): StudySection[] {
  const headings = sections.reduce((sum, section) => sum + section.heading.length + 6, 0);
  const total = studyCharacters(sections) || 1;
  const available = Math.max(0, capacity - headings);
  return sections.flatMap((section) => {
    const allowance = Math.floor((available * section.text.length) / total);
    return allowance < MIN_SECTION_CHARACTERS
      ? []
      : [{ heading: section.heading, text: clipPassage(section.text, allowance) }];
  });
}

/** Pack `sections` into at most `budget.maxChunks` parts of `budget.chunkCharacters`. */
export function chunkStudySections(
  sections: readonly StudySection[],
  budget: StudyBudget,
): StudyChunking {
  const max = budget.chunkCharacters;
  let parts = pack(sections, max);
  let shortened = false;
  if (parts.length > budget.maxChunks) {
    shortened = true;
    // Packing wastes the tail of each part, so aim below the exact capacity
    // and tighten until the parts fit.
    let capacity = budget.maxChunks * max * 0.9;
    for (let attempt = 0; attempt < 8 && parts.length > budget.maxChunks; attempt++) {
      parts = pack(shorten(sections, capacity), max);
      capacity *= 0.85;
    }
    // Unreachable in practice; never send more parts than the budget allows.
    parts = parts.slice(0, budget.maxChunks);
  }
  return { chunks: parts.map((text, index) => ({ index, text })), shortened };
}
