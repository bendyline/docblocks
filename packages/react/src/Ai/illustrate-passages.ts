/**
 * Passages a diagram could illustrate, and where diagrams go in the source.
 *
 * A passage is a top-level paragraph, list, or table, numbered P1…Pn so a
 * model can refer to it without quoting it. Passages are scored on cues that
 * a picture would help (dates, numbers, ordered steps, actors exchanging
 * messages, contrasts, part-whole wording) so a small model only sees the
 * likeliest few.
 *
 * Insertion is planned against the live source: each passage is re-found,
 * fences go straight after it, and drawings and layouts go at the end of its
 * section at a heading depth that cannot capture what follows.
 */

import { extractPlainText, parseMarkdown, type MarkdownNode } from '@bendyline/squisq/markdown';
import { isContainerTemplate } from '@bendyline/squisq/doc';
import {
  applySourceEditsToText,
  blockInsertionPoint,
  headingDepthForInsertion,
  joinBlockAt,
  normalizeSourceEdits,
  type MarkdownSourceEdit,
} from '@bendyline/squisq-editor-react';
import { findUniqueExcerpt } from './ai-assistant.js';
import { clip } from './diagram-sanitize.js';
import type { CompiledDiagram } from './diagram-compile.js';
import { parseLooseNumber } from './diagram-spec.js';

export type PassageKind = 'paragraph' | 'list' | 'table';

export interface PassageHints {
  readonly dates: number;
  readonly numbers: number;
  readonly ordered: boolean;
  readonly sequence: number;
  readonly actors: number;
  readonly contrast: number;
  readonly parts: number;
  readonly numericTable: boolean;
}

export interface Passage {
  /** `P1`, `P2`, … in document order. */
  readonly id: string;
  readonly index: number;
  readonly kind: PassageKind;
  /** Source range `[start, end)` when the passage was found. */
  readonly start: number;
  readonly end: number;
  /** Exact source text, used to find the passage again after edits. */
  readonly text: string;
  /** Plain text, for prompts and grounding. */
  readonly plain: string;
  /** Text of the heading the passage sits under, or '' before any heading. */
  readonly heading: string;
  /** Which section the passage is in: 0 before the first heading, then one per heading. */
  readonly section: number;
  readonly hints: PassageHints;
  readonly score: number;
}

const MIN_PARAGRAPH_CHARACTERS = 80;
const OUTLINE_PASSAGE_CHARACTERS = 240;
const VISUAL_FENCES = new Set(['mermaid', 'timeline', 'tree', 'diagram']);

const SEQUENCE_CUES =
  /\b(first|then|next|after|afterwards|finally|step|stage|before|once|followed by|subsequently)\b/giu;
const ACTOR_CUES =
  /\b(sends?|requests?|responds?|replies|returns?|calls?|forwards?|receives?|notifies|queries|asks|confirms)\b/giu;
const CONTRAST_CUES =
  /\b(vs\.?|versus|compared|whereas|unlike|while|pros|cons|advantages?|disadvantages?|trade-?offs?|instead)\b/giu;
const PART_CUES =
  /\b(consists? of|composed of|made up of|includes?|comprises?|types of|kinds of|categories|components|divided into|parts)\b/giu;
const DATE_CUES =
  /\b(1\d{3}|2\d{3})\b|\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\s+\d{4}\b|\bq[1-4]\s+\d{4}\b/giu;
const NUMBER_CUES = /(?<![\w.])[-−]?\$?\d[\d,]*(?:\.\d+)?\s?(%|k|m|bn|million|billion)?(?![\w])/giu;

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function isNumericTable(node: MarkdownNode): boolean {
  if (node.type !== 'table') return false;
  const rows = node.children.slice(1);
  if (rows.length < 2) return false;
  const width = Math.max(...rows.map((row) => row.children.length));
  for (let column = 1; column < width; column++) {
    const cells = rows.map((row) =>
      extractPlainText(row.children[column] ?? { type: 'text', value: '' }),
    );
    const numeric = cells.filter((cell) => parseLooseNumber(cell.trim()) !== null).length;
    if (numeric >= 0.6 * cells.length) return true;
  }
  return false;
}

function hintsFor(node: MarkdownNode, plain: string): PassageHints {
  const dates = count(plain, DATE_CUES);
  const numbers = Math.max(0, count(plain, NUMBER_CUES) - count(plain, /\b(1\d{3}|2\d{3})\b/gu));
  return {
    dates,
    numbers,
    ordered: node.type === 'list' && node.ordered,
    sequence: count(plain, SEQUENCE_CUES),
    actors: count(plain, ACTOR_CUES),
    contrast: count(plain, CONTRAST_CUES),
    parts: count(plain, PART_CUES),
    numericTable: isNumericTable(node),
  };
}

function scoreOf(hints: PassageHints): number {
  return (
    (hints.dates >= 2 ? 3 : 0) +
    (hints.numbers >= 2 ? 2 : 0) +
    (hints.ordered ? 2 : 0) +
    Math.min(hints.sequence, 3) +
    Math.min(hints.actors, 3) +
    Math.min(hints.contrast, 2) +
    Math.min(hints.parts, 2) +
    (hints.numericTable ? 4 : 0)
  );
}

/** True for a block that is already a picture: a visual fence, an image, or embedded media. */
function isVisual(node: MarkdownNode | undefined): boolean {
  if (!node) return false;
  if (node.type === 'code') return VISUAL_FENCES.has((node.lang ?? '').toLowerCase());
  if (node.type === 'htmlBlock') return /<(img|video|svg|figure)\b/iu.test(node.rawHtml);
  if (node.type === 'paragraph') {
    return (
      node.children.length > 0 &&
      node.children.every(
        (child) => child.type === 'image' || (child.type === 'text' && !child.value.trim()),
      )
    );
  }
  return false;
}

/** Every passage in `source`, in document order. */
export function segmentPassages(source: string): Passage[] {
  let children: MarkdownNode[];
  try {
    children = parseMarkdown(source).children;
  } catch {
    return [];
  }
  const passages: Passage[] = [];
  let heading = '';
  let section = 0;
  let templated = false;
  children.forEach((node, position) => {
    if (node.type === 'heading') {
      heading = extractPlainText(node).trim();
      section++;
      // Slides, charts, and the children of drawings and layouts are already
      // laid out by their template; leave them alone.
      templated =
        Boolean(node.templateAnnotation?.template) ||
        isContainerTemplate(node.templateAnnotation?.template);
      return;
    }
    if (templated) return;
    if (node.type !== 'paragraph' && node.type !== 'list' && node.type !== 'table') return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (typeof start !== 'number' || typeof end !== 'number') return;
    if (isVisual(node) || isVisual(children[position + 1])) return;
    const plain = extractPlainText(node).replace(/\s+/gu, ' ').trim();
    if (node.type === 'paragraph' && plain.length < MIN_PARAGRAPH_CHARACTERS) return;
    if (node.type === 'list' && node.children.length < 2) return;
    const hints = hintsFor(node, plain);
    passages.push({
      id: `P${String(passages.length + 1)}`,
      index: passages.length,
      kind: node.type,
      start,
      end,
      text: source.slice(start, end),
      plain,
      heading,
      section,
      hints,
      score: scoreOf(hints),
    });
  });
  return passages;
}

/** Clip to a sentence boundary when one falls in the last third. */
export function clipPassage(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  return stop >= max * 0.66 ? head.slice(0, stop + 1) : clip(text, max);
}

export interface Shortlist {
  /** The passages shown to the planner, each with the excerpt it sees. */
  readonly entries: readonly { readonly passage: Passage; readonly excerpt: string }[];
  /** `outline` when nothing scored and every passage is shown, clipped short. */
  readonly mode: 'shortlist' | 'outline';
}

/** The likeliest passages, in document order, within `budgetCharacters`. */
export function shortlistPassages(
  passages: readonly Passage[],
  budgetCharacters: number,
  maxPassages = 8,
): Shortlist {
  const scored = passages
    .filter((passage) => passage.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxPassages)
    .sort((a, b) => a.index - b.index);
  if (scored.length > 0) {
    const each = Math.max(OUTLINE_PASSAGE_CHARACTERS, Math.floor(budgetCharacters / scored.length));
    return {
      mode: 'shortlist',
      entries: scored.map((passage) => ({ passage, excerpt: clipPassage(passage.plain, each) })),
    };
  }
  const entries: { passage: Passage; excerpt: string }[] = [];
  let used = 0;
  for (const passage of passages) {
    const excerpt = clipPassage(passage.plain, OUTLINE_PASSAGE_CHARACTERS);
    if (used + excerpt.length > budgetCharacters) break;
    used += excerpt.length;
    entries.push({ passage, excerpt });
  }
  return { mode: 'outline', entries };
}

/** The passage's current range in `source`, or null when it changed or repeats. */
export function locatePassage(
  source: string,
  passage: Passage,
): { readonly start: number; readonly end: number } | null {
  if (source.slice(passage.start, passage.end) === passage.text) {
    return { start: passage.start, end: passage.end };
  }
  const start = findUniqueExcerpt(source, passage.text);
  return start === null ? null : { start, end: start + passage.text.length };
}

/** The document's title: frontmatter `title`, else its first heading. */
export function documentTitle(source: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(source)?.[1] ?? '';
  const fromFrontmatter = /^title:\s*["']?(.+?)["']?\s*$/mu.exec(frontmatter)?.[1];
  if (fromFrontmatter) return fromFrontmatter;
  return /^#{1,6}\s+(.+?)\s*(\{.*)?$/mu.exec(source)?.[1] ?? '';
}

/** Every `{#id}` already used in `markdown`. */
export function idsIn(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(/\{#([A-Za-z0-9][\w-]*)/gu)].map((match) => match[1] ?? ''));
}

export interface PendingInsertion {
  /** Caller's key for this item, echoed back in `stale` / `unplaceable`. */
  readonly key: string;
  readonly passage: Passage;
  readonly compiled: CompiledDiagram;
}

export interface InsertionPlan {
  /** Edits for `applySourceEdits`; empty when nothing could be placed. */
  readonly edits: readonly MarkdownSourceEdit[];
  /** The source after the edits. */
  readonly next: string;
  /** Items whose passage changed or can no longer be found uniquely. */
  readonly stale: readonly string[];
  /** Items with no heading depth that would not capture what follows. */
  readonly unplaceable: readonly string[];
}

/** Plan the edits that put every placeable item into `source` at once. */
export function planInsertions(source: string, items: readonly PendingInsertion[]): InsertionPlan {
  const stale: string[] = [];
  const unplaceable: string[] = [];
  const groups = new Map<
    string,
    { offset: number; members: { item: PendingInsertion; depth: number }[] }
  >();
  for (const item of items) {
    const located = locatePassage(source, item.passage);
    if (!located) {
      stale.push(item.key);
      continue;
    }
    let offset = located.end;
    let depth = 2;
    if (item.compiled.placement === 'sectionEnd') {
      const point = blockInsertionPoint(source, located.start, 'sectionEnd');
      const fitted = headingDepthForInsertion(point, { childLevels: 1 });
      if (fitted === null) {
        unplaceable.push(item.key);
        continue;
      }
      offset = point.offset;
      depth = fitted;
    }
    // Items whose insertion points share a run of blank lines go in one edit.
    const range = joinBlockAt(source, offset, 'x');
    const groupKey = `${String(range.start)}:${String(range.end)}`;
    const group = groups.get(groupKey) ?? { offset, members: [] };
    group.members.push({ item, depth });
    groups.set(groupKey, group);
  }
  const taken = idsIn(source);
  const edits: MarkdownSourceEdit[] = [];
  for (const group of groups.values()) {
    // A fence after a heading block would become part of it, so fences first.
    const ordered = [...group.members].sort(
      (a, b) =>
        Number(a.item.compiled.placement === 'sectionEnd') -
          Number(b.item.compiled.placement === 'sectionEnd') ||
        a.item.passage.index - b.item.passage.index,
    );
    const blocks = ordered.map(({ item, depth }) => {
      const markdown = item.compiled.render(depth, taken);
      for (const id of idsIn(markdown)) taken.add(id);
      return markdown;
    });
    edits.push(joinBlockAt(source, group.offset, blocks.join('\n\n')));
  }
  const normalized = normalizeSourceEdits(source, edits) ?? [];
  return {
    edits: normalized,
    next: normalized.length > 0 ? applySourceEditsToText(source, normalized) : source,
    stale,
    unplaceable,
  };
}
