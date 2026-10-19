/**
 * SVG pictures in AI prompts and in AI output.
 *
 * A ```svg fence renders as a picture (a Squisq SVG island), but its source is
 * markup — often tens of kilobytes of it, meaningless to a writing model and
 * enough to fill a small local model's whole context. Prompts carry a
 * one-line stand-in for each picture instead.
 *
 * Going the other way, a model that writes SVG rarely writes the one form that
 * renders: raw `<svg>` HTML is dropped by the renderer, and an ```xml or
 * ```html fence shows as code. Output is normalized so a complete SVG the
 * model wrote lands as a ```svg fence. Only what the model wrote changes: a
 * fence or block already in the document is left as the author had it.
 */

import {
  isSvgIslandLang,
  parseMarkdown,
  parseSvgIsland,
  walkMarkdownTree,
  type MarkdownNode,
} from '@bendyline/squisq/markdown';
import { cleanLabel } from './diagram-sanitize.js';

/** Starts every stand-in, so findings that quote one can be recognized. */
export const SVG_PICTURE_PLACEHOLDER = '[SVG picture';

export interface PictureRange {
  readonly start: number;
  readonly end: number;
  readonly title: string;
}

/** Cheap pre-check so documents without SVG pictures are never parsed. */
const SVG_FENCE_HINT = /^[ \t]*(?:`{3,}|~{3,})[ \t]*svg\b/imu;
/** Fence languages a model uses for SVG it means as a picture. */
const SVG_AS_CODE_LANGS = new Set(['xml', 'html']);
const TITLE_CHARACTERS = 80;

function parse(source: string): MarkdownNode | null {
  try {
    return parseMarkdown(source);
  } catch {
    return null;
  }
}

function rangeOf(node: MarkdownNode): { start: number; end: number } | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : null;
}

/** A picture's accessible name, read loosely from its source. */
function pictureTitle(svg: string): string {
  const raw =
    /<svg\b[^>]*\baria-label\s*=\s*"([^"]{1,200})"/iu.exec(svg)?.[1] ??
    /<title\b[^>]*>([^<]{1,200})<\/title>/iu.exec(svg)?.[1] ??
    '';
  return cleanLabel(raw, TITLE_CHARACTERS);
}

/** Source ranges of every ```svg fence in `source`, at any depth. */
export function svgPictureRanges(source: string): readonly PictureRange[] {
  if (!SVG_FENCE_HINT.test(source)) return [];
  const document = parse(source);
  if (!document) return [];
  const ranges: PictureRange[] = [];
  walkMarkdownTree(document, (node) => {
    if (node.type !== 'code' || !isSvgIslandLang(node.lang)) return;
    const range = rangeOf(node);
    if (range) ranges.push({ ...range, title: pictureTitle(node.value) });
  });
  return ranges;
}

function placeholder(title: string): string {
  return `${SVG_PICTURE_PLACEHOLDER}${title ? `: ${title}` : ''} (source omitted)]`;
}

let elisionCache: { readonly source: string; readonly elided: string } | null = null;

/**
 * `source` with each ```svg fence replaced by a one-line stand-in. The stand-in
 * has no line breaks, so it is safe inside a list item or block quote.
 * Memoized on the last source: draft requests are rebuilt on every keystroke.
 */
export function elideSvgPictures(source: string): string {
  if (elisionCache?.source === source) return elisionCache.elided;
  let elided = source;
  for (const range of [...svgPictureRanges(source)].reverse()) {
    elided = elided.slice(0, range.start) + placeholder(range.title) + elided.slice(range.end);
  }
  elisionCache = { source, elided };
  return elided;
}

/** One sentence for a system prompt whose document had pictures elided, else ''. */
export function pictureStandInNote(original: string, elided: string): string {
  return original === elided
    ? ''
    : ` A line starting "${SVG_PICTURE_PLACEHOLDER}" stands for a picture whose source is not shown; ` +
        'never quote, change, or reproduce it.';
}

interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** A fence of backticks longer than any run inside `body`. */
function fenceFor(body: string): string {
  const longest = Math.max(0, ...[...body.matchAll(/`+/gu)].map((match) => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Retag an ```xml/```html fence that holds exactly one valid SVG document. */
function retagEdit(markdown: string, node: MarkdownNode, existing: string): TextEdit | null {
  if (node.type !== 'code') return null;
  const lang = node.lang?.trim().toLowerCase() ?? '';
  if (!SVG_AS_CODE_LANGS.has(lang)) return null;
  const range = rangeOf(node);
  if (!range) return null;
  const fenceText = markdown.slice(range.start, range.end);
  if (existing.includes(fenceText)) return null;
  if (!/^\s*(<\?xml\b|<!--|<!doctype\s+svg\b|<svg\b)/iu.test(node.value)) return null;
  if (!parseSvgIsland(node.value).ok) return null;
  const opener = /^([ \t]*(?:`{3,}|~{3,})[ \t]*)(xml|html)\b/iu.exec(fenceText);
  if (!opener?.[1]) return null;
  const at = range.start + opener[1].length;
  return { start: at, end: at + lang.length, text: 'svg' };
}

/** Where the `<svg>` element opened at `start` closes, honoring nested `<svg>`s. */
function svgElementEnd(markdown: string, start: number): number | null {
  const tags = /<svg\b[^>]*>|<\/svg\s*>/giu;
  tags.lastIndex = start;
  let depth = 0;
  for (let match = tags.exec(markdown); match; match = tags.exec(markdown)) {
    const tag = match[0];
    if (tag.startsWith('</')) depth -= 1;
    else if (!tag.endsWith('/>')) depth += 1;
    if (depth <= 0) return match.index + tag.length;
  }
  return null;
}

/** Fence raw `<svg>` blocks that start a line outside any code block. */
function wrapEdits(
  markdown: string,
  code: readonly { start: number; end: number }[],
  existing: string,
): TextEdit[] {
  const edits: TextEdit[] = [];
  const opens = /^<svg\b/gimu;
  let resumeAt = 0;
  for (const open of markdown.matchAll(opens)) {
    const start = open.index ?? 0;
    if (start < resumeAt) continue;
    if (code.some((range) => start >= range.start && start < range.end)) continue;
    const end = svgElementEnd(markdown, start);
    if (end === null) continue;
    const lineEnd = markdown.indexOf('\n', end);
    if (markdown.slice(end, lineEnd < 0 ? markdown.length : lineEnd).trim()) continue;
    const svg = markdown.slice(start, end);
    if (existing.includes(svg) || !parseSvgIsland(svg).ok) continue;
    // An XML prolog or doctype line just above belongs to the same document.
    let from = start;
    for (;;) {
      const previousEnd = from - 1;
      if (previousEnd <= 0) break;
      const previousStart = markdown.lastIndexOf('\n', previousEnd - 1) + 1;
      const line = markdown.slice(previousStart, previousEnd).trim();
      if (!/^(<\?xml\b.*\?>|<!doctype\s+svg\b[^>]*>)$/iu.test(line)) break;
      from = previousStart;
    }
    const fence = fenceFor(svg);
    edits.push({ start: from, end, text: `${fence}svg\n${svg}\n${fence}` });
    resumeAt = end;
  }
  return edits;
}

/**
 * Make SVG the model wrote render as a picture: fence raw `<svg>` blocks and
 * retag ```xml/```html fences that hold one SVG document. `existing` is the
 * document the model saw; anything copied verbatim from it is left alone, so
 * an author's ```xml fence that deliberately shows SVG source stays code.
 */
export function normalizeGeneratedPictures(markdown: string, existing = ''): string {
  if (!/<svg\b/iu.test(markdown)) return markdown;
  const document = parse(markdown);
  if (!document) return markdown;
  const code: { start: number; end: number }[] = [];
  const edits: TextEdit[] = [];
  walkMarkdownTree(document, (node) => {
    if (node.type !== 'code') return;
    const range = rangeOf(node);
    if (range) code.push(range);
    const retag = retagEdit(markdown, node, existing);
    if (retag) edits.push(retag);
  });
  edits.push(...wrapEdits(markdown, code, existing));
  let next = markdown;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  }
  return next;
}
