/**
 * Cut a document into parts a small model can review, one request each.
 *
 * Apple's on-device model has a 4,096-token context and stops every reply at
 * 1,024 tokens, so a long document sent in one review request leaves no room
 * for the findings, or does not fit at all. Parts are cut from the Markdown
 * itself, never from a plain-text rendering: a finding quotes its part
 * exactly, and Apply looks for that quote in the document. Cuts fall between
 * blocks and outside code fences, and before a heading when one is near.
 */

/** Characters per token, deliberately low so prompts never overrun the window. */
const CHARACTERS_PER_TOKEN = 3;
const SAFETY_TOKENS = 150;
const SMALL_CONTEXT = 16_384;

/**
 * Findings one request asks a small model for. Each runs to about 150
 * tokens, and Apple's on-device model stops every reply at 1,024: asked for
 * 12, it was cut off partway through the eighth. Six leave room for the array
 * around them. A long document is reviewed in parts, so this bounds a part,
 * not the review.
 */
export const SMALL_MODEL_FINDINGS = 6;
/** Six findings at about 150 tokens each, and the array around them. */
const SMALL_REPLY_TOKENS = 1_200;

function contextTokensOf(contextWindow: number | null): number {
  return contextWindow !== null && contextWindow > 0 ? contextWindow : 4_096;
}

/**
 * Most findings one review request asks for: a few on a small model, whose
 * reply holds no more, else every one it finds. Unknown windows are small.
 */
export function reviewFindingLimit(contextWindow: number | null): number | null {
  return contextTokensOf(contextWindow) < SMALL_CONTEXT ? SMALL_MODEL_FINDINGS : null;
}
/** The reply a review request leaves room for on a larger model (its `maxTokens`). */
const LARGE_REPLY_TOKENS = 8_192;
const MIN_PART_CHARACTERS = 1_200;
/** A part this full ends before the next heading rather than run past it. */
const HEADING_CUT_FILL = 0.6;

/**
 * Characters of document one review request can carry, given the characters
 * of everything else it sends. Unknown windows are treated as 4K.
 */
export function reviewPartCharacters(
  contextWindow: number | null,
  promptCharacters: number,
): number {
  const contextTokens = contextTokensOf(contextWindow);
  const replyTokens = contextTokens < SMALL_CONTEXT ? SMALL_REPLY_TOKENS : LARGE_REPLY_TOKENS;
  const documentTokens =
    contextTokens -
    replyTokens -
    SAFETY_TOKENS -
    Math.ceil(promptCharacters / CHARACTERS_PER_TOKEN);
  return Math.max(MIN_PART_CHARACTERS, documentTokens * CHARACTERS_PER_TOKEN);
}

interface Piece {
  readonly start: number;
  readonly end: number;
  /** The piece opens with a heading, a good place to start a part. */
  readonly heading: boolean;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/u;

/** Each line of `text` as [start, end) offsets, end including its newline. */
function lineRanges(text: string, start: number, end: number): [number, number][] {
  const lines: [number, number][] = [];
  let position = start;
  while (position < end) {
    const newline = text.indexOf('\n', position);
    const next = newline < 0 || newline >= end ? end : newline + 1;
    lines.push([position, next]);
    position = next;
  }
  return lines;
}

/** The blocks of `markdown`: runs of lines between blank lines, fences kept whole. */
function blocks(markdown: string): Piece[] {
  const pieces: Piece[] = [];
  let start = 0;
  let heading = false;
  let fence: string | null = null;
  let afterBlank = false;
  for (const [lineStart, lineEnd] of lineRanges(markdown, 0, markdown.length)) {
    const line = markdown.slice(lineStart, lineEnd).replace(/\r?\n$/u, '');
    if (fence !== null) {
      const marker = FENCE.exec(line)?.[1];
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        !line.trim().slice(marker.length).trim()
      ) {
        fence = null;
      }
      continue;
    }
    const blank = !line.trim();
    const opensHeading = HEADING.test(line);
    if (!blank && lineStart > start && (afterBlank || opensHeading)) {
      pieces.push({ start, end: lineStart, heading });
      start = lineStart;
      heading = false;
    }
    if (!blank && lineStart === start) heading = opensHeading;
    fence = FENCE.exec(line)?.[1] ?? null;
    afterBlank = blank;
  }
  if (start < markdown.length) pieces.push({ start, end: markdown.length, heading });
  return pieces;
}

/** [start, end) of `text` in runs no longer than `max`, cut after a sentence, else a space. */
function cutLong(text: string, start: number, end: number, max: number): Piece[] {
  const pieces: Piece[] = [];
  let position = start;
  while (end - position > max) {
    const window = text.slice(position, position + max);
    const sentence = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
    );
    const space = window.lastIndexOf(' ');
    let cut = sentence > max / 2 ? sentence + 2 : space > max / 2 ? space + 1 : max;
    // Never between the halves of a surrogate pair, which no quote could match.
    if (/[\uD800-\uDBFF]/u.test(text[position + cut - 1] ?? '')) cut -= 1;
    pieces.push({ start: position, end: position + cut, heading: false });
    position += cut;
  }
  pieces.push({ start: position, end, heading: false });
  return pieces;
}

/** `block` as pieces no longer than `max`: whole, else by line, else by sentence. */
function fit(markdown: string, block: Piece, max: number): Piece[] {
  if (block.end - block.start <= max) return [block];
  return lineRanges(markdown, block.start, block.end).flatMap(([start, end], index) =>
    end - start <= max
      ? [{ start, end, heading: index === 0 && block.heading }]
      : cutLong(markdown, start, end, max),
  );
}

/**
 * `markdown` in parts of at most `max` characters, in document order. Each
 * part is a contiguous excerpt of `markdown` with its edges trimmed, so any
 * text quoted from a part is found in the document as written.
 */
export function splitReviewParts(markdown: string, max: number): string[] {
  const parts: string[] = [];
  let partStart = 0;
  let partEnd = 0;
  const close = () => {
    const text = markdown
      .slice(partStart, partEnd)
      .replace(/^(?:[ \t]*\r?\n)+/u, '')
      .trimEnd();
    if (text) parts.push(text);
  };
  for (const piece of blocks(markdown).flatMap((block) => fit(markdown, block, max))) {
    const filled = partEnd - partStart;
    if (
      filled > 0 &&
      (piece.end - partStart > max || (piece.heading && filled >= max * HEADING_CUT_FILL))
    ) {
      close();
      partStart = piece.start;
    }
    partEnd = piece.end;
  }
  close();
  return parts;
}
