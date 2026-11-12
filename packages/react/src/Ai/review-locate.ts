/**
 * Where a review finding's text is in the document now.
 *
 * A finding quotes the document as it was reviewed. By the time someone
 * clicks it they may have edited that passage, applied another finding next
 * to it, or moved things around. The quote itself is tried first; failing
 * that, the text that surrounded it in the reviewed document marks where it
 * went; failing that, the line most like it. Any location but an exact quote
 * is reported as inexact, so the panel can say the text has changed.
 */

/** [start, end) offsets into a source. */
export interface ExcerptRange {
  readonly start: number;
  readonly end: number;
}

export interface ExcerptLocation extends ExcerptRange {
  /** The text there is the quote, unchanged but perhaps for its spacing and line breaks. */
  readonly exact: boolean;
}

/** Where `needle` starts in `text`, stopping once `limit` are found. */
function occurrences(text: string, needle: string, limit = Infinity): number[] {
  const found: number[] = [];
  for (
    let index = text.indexOf(needle);
    index >= 0 && found.length < limit;
    index = text.indexOf(needle, index + 1)
  ) {
    found.push(index);
  }
  return found;
}

const BLANK_LINE = /\n[^\S\n]*\n/u;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Where `quote` occurs in `text`, stopping once `limit` are found.
 *
 * Copies character for character come first. Only when there are none does a
 * run of spaces or line breaks inside the quote match any such run in the
 * text: a model quoting hard-wrapped Markdown often drops the indent of a list
 * item's continuation line, or joins the lines, and it still means the passage
 * it read. Such a run never reaches across a blank line the quote does not
 * have, so a quote cannot stand for two paragraphs it ran together.
 */
export function quoteOccurrences(text: string, quote: string, limit = Infinity): ExcerptRange[] {
  if (!quote) return [];
  const exact = occurrences(text, quote, limit).map((start) => ({
    start,
    end: start + quote.length,
  }));
  if (exact.length > 0 || !/\S\s+\S/u.test(quote)) return exact;
  // The quote's own leading and trailing whitespace stays exact.
  const lead = /^\s*/u.exec(quote)?.[0] ?? '';
  const trail = /\s*$/u.exec(quote)?.[0] ?? '';
  const body = quote.slice(lead.length, quote.length - trail.length);
  const pattern = new RegExp(
    escapeRegExp(lead) + body.split(/\s+/u).map(escapeRegExp).join('\\s+') + escapeRegExp(trail),
    'gu',
  );
  const blankLines = BLANK_LINE.test(quote);
  const found: ExcerptRange[] = [];
  for (let match = pattern.exec(text); match && found.length < limit; match = pattern.exec(text)) {
    if (blankLines || !BLANK_LINE.test(match[0])) {
      found.push({ start: match.index, end: match.index + match[0].length });
    }
    // Overlapping copies count too, as they do for an exact quote.
    pattern.lastIndex = match.index + 1;
  }
  return found;
}

/** Context lengths to try around a quote, longest first. */
const ANCHOR_LENGTHS = [64, 40, 24, 14];
/** Shorter context matches too much to place anything. */
const MIN_ANCHOR_CHARACTERS = 8;

/** The first of `candidates` that occurs exactly once in `text`. */
function uniqueAnchor(
  text: string,
  candidates: readonly string[],
): { index: number; length: number } | null {
  for (const candidate of candidates) {
    if (candidate.trim().length < MIN_ANCHOR_CHARACTERS) continue;
    const found = occurrences(text, candidate, 2);
    if (found.length === 1) return { index: found[0] ?? 0, length: candidate.length };
  }
  return null;
}

/** [start, end) without the whitespace at either edge; empty at `start` when all space. */
function trimmed(text: string, start: number, end: number): { start: number; end: number } {
  let from = start;
  let to = end;
  while (from < to && /\s/u.test(text[from] ?? '')) from += 1;
  while (to > from && /\s/u.test(text[to - 1] ?? '')) to -= 1;
  return { start: from, end: to };
}

const WORD = /[\p{L}\p{N}]/u;

/**
 * Where the reviewed text at [start, end) of `reviewed` went in `current`,
 * found by the text around it. Null when neither side can be found once.
 */
function anchoredLocation(
  current: string,
  reviewed: string,
  start: number,
  end: number,
): { start: number; end: number } | null {
  // Without the whitespace that touches the quote, which both sides would
  // otherwise share when the text between them was deleted.
  const before = uniqueAnchor(
    current,
    ANCHOR_LENGTHS.map((length) =>
      reviewed.slice(Math.max(0, start - length), start).replace(/\s+$/u, ''),
    ),
  );
  const after = uniqueAnchor(
    current,
    ANCHOR_LENGTHS.map((length) => reviewed.slice(end, end + length).replace(/^\s+/u, '')),
  );
  const span = end - start;
  const from = before ? before.index + before.length : null;
  const to = after ? after.index : null;
  // Both sides found, in order, and not so far apart that something else came between.
  if (from !== null && to !== null && from <= to && to - from <= span * 3 + 200) {
    return trimmed(current, from, to);
  }
  // One side only: as long as the quote was, ending on a whole word, and
  // within one line unless the quote ran over several.
  const multiline = reviewed.slice(start, end).includes('\n');
  if (from !== null) {
    let begin = from;
    while (begin < current.length && /\s/u.test(current[begin] ?? '')) begin += 1;
    const lineEnd = current.indexOf('\n', begin);
    const limit = multiline || lineEnd < 0 ? current.length : lineEnd;
    let stop = Math.min(begin + span, limit);
    while (stop < limit && WORD.test(current[stop] ?? '')) stop += 1;
    return trimmed(current, begin, stop);
  }
  if (to !== null) {
    let stop = to;
    while (stop > 0 && /\s/u.test(current[stop - 1] ?? '')) stop -= 1;
    const limit = multiline ? 0 : current.lastIndexOf('\n', stop - 1) + 1;
    let begin = Math.max(stop - span, limit);
    while (begin > limit && WORD.test(current[begin - 1] ?? '')) begin -= 1;
    return trimmed(current, begin, stop);
  }
  return null;
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** How alike two passages' words are, from 0 to 1. */
function likeness(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return (2 * shared) / (a.size + b.size || 1);
}

/** Below this, the most similar line is more likely another passage than this one. */
const MIN_LIKENESS = 0.5;

/** The line of `current` most like `quote`, when one is alike enough. */
function similarLine(current: string, quote: string): { start: number; end: number } | null {
  const target = words(quote);
  if (target.size < 3) return null;
  let best: { start: number; end: number } | null = null;
  let bestScore = MIN_LIKENESS;
  let lineStart = 0;
  for (const line of current.split('\n')) {
    const score = likeness(words(line), target);
    if (score > bestScore) {
      best = trimmed(current, lineStart, lineStart + line.length);
      bestScore = score;
    }
    lineStart += line.length + 1;
  }
  return best;
}

/**
 * Where `quote`, taken from `reviewed`, is in `current`. Null when it cannot
 * be placed at all.
 */
export function locateReviewExcerpt(
  current: string,
  reviewed: string | null,
  quote: string,
): ExcerptLocation | null {
  if (!quote) return null;
  const copies = quoteOccurrences(current, quote);
  const [first] = copies;
  if (first && copies.length === 1) return { ...first, exact: true };

  const origin = reviewed ? quoteOccurrences(reviewed, quote, 1)[0] : undefined;
  const anchored =
    reviewed && origin ? anchoredLocation(current, reviewed, origin.start, origin.end) : null;
  if (first) {
    // Several copies: the one nearest where the reviewed one was.
    const target = anchored?.start ?? origin?.start ?? 0;
    const nearest = copies.reduce((best, candidate) =>
      Math.abs(candidate.start - target) < Math.abs(best.start - target) ? candidate : best,
    );
    return { ...nearest, exact: true };
  }
  const found = anchored ?? similarLine(current, quote);
  return found ? { ...found, exact: false } : null;
}
