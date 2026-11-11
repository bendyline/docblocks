/**
 * Document text a model copied into a draft meant to be inserted into that
 * document.
 *
 * Add content shows the model the whole document. Small on-device models
 * return parts of it with their new text: Apple's model repeated the title in
 * 6 of 6 tries, once with the rest of the document after its introduction and
 * once with a fenced copy of the whole document, and Gemma 4 E2B returned the
 * whole document ahead of its story. A prompt asking for new text only cut
 * Apple's copies to 3 of 8 but did not stop them, so the copy is also removed
 * from the reply.
 *
 * Only runs at the draft's two ends are removed, and only when they are
 * clearly a copy: two or more blocks the document already has, or its first
 * (or last) block. A single heading that matches one elsewhere in the
 * document, such as another "Example", is new text and stays.
 */

import {
  parseMarkdown,
  splitFrontmatterBlock,
  type MarkdownDocument,
  type MarkdownNode,
} from '@bendyline/squisq/markdown';
import { elideSvgPictures } from './ai-pictures.js';

/** A Squisq block annotation; a model may drop or keep it when copying a heading. */
const ANNOTATION = /\{\[[^\]]*\]\}/gu;
const WORD = /[\p{L}\p{N}]/u;
/** Fences a model wraps a copy of the document in. */
const DOCUMENT_FENCE_LANGS = new Set(['', 'markdown', 'md']);

interface DraftBlock {
  readonly start: number;
  readonly end: number;
  /** Document blocks this one copies; 0 for one without words, null for new text. */
  readonly copies: number | null;
  readonly first: boolean;
  readonly last: boolean;
}

interface DocumentBlocks {
  readonly keys: ReadonlySet<string>;
  readonly first: ReadonlySet<string>;
  readonly last: ReadonlySet<string>;
  readonly frontmatter: string | null;
}

export interface DocumentEchoResult {
  /** The draft without the copied runs; empty when it was nothing but a copy. */
  readonly text: string;
  readonly removed: boolean;
}

function parse(source: string): MarkdownDocument | null {
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

/**
 * What a block says, for comparison: models change a heading's level, the
 * spacing and the closing punctuation when they copy a block ("This is fun"
 * came back as "This is fun."), so none of those counts.
 */
function blockKey(source: string, node: MarkdownNode): string {
  const text =
    node.type === 'heading'
      ? source.replace(/^#{1,6}[ \t]*/u, '').replace(/[ \t]+#+[ \t]*$/u, '')
      : source;
  return text
    .replace(ANNOTATION, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.!?…:;,]+$/u, '');
}

/** Keys of the top-level blocks that have words, in order. */
function wordKeys(source: string, root: MarkdownDocument): string[] {
  const keys: string[] = [];
  for (const node of root.children) {
    const range = rangeOf(node);
    if (!range) continue;
    const key = blockKey(source.slice(range.start, range.end), node);
    if (WORD.test(key)) keys.push(key);
  }
  return keys;
}

/** A leading YAML block, as written, for comparison. */
function frontmatterOf(source: string): string | null {
  const text = splitFrontmatterBlock(source).frontmatter?.replace(/\s+/gu, ' ').trim();
  return text ? text : null;
}

function documentBlocks(documentSource: string): DocumentBlocks | null {
  const keys = new Set<string>();
  const first = new Set<string>();
  const last = new Set<string>();
  let frontmatter: string | null = null;
  // The model saw a stand-in for each SVG picture; it may copy either form.
  for (const source of new Set([documentSource, elideSvgPictures(documentSource)])) {
    const root = parse(source);
    if (!root) continue;
    frontmatter ??= frontmatterOf(source);
    const ordered = wordKeys(source, root);
    for (const key of ordered) keys.add(key);
    const opening = ordered[0];
    const closing = ordered.at(-1);
    if (opening !== undefined) first.add(opening);
    if (closing !== undefined) last.add(closing);
  }
  return keys.size > 0 || frontmatter ? { keys, first, last, frontmatter } : null;
}

/** A fence holding nothing but blocks the document has: the document pasted as code. */
function fencedCopy(node: MarkdownNode, document: DocumentBlocks): string[] | null {
  if (node.type !== 'code' || !DOCUMENT_FENCE_LANGS.has((node.lang ?? '').toLowerCase())) {
    return null;
  }
  const inner = parse(node.value);
  if (!inner) return null;
  const keys = wordKeys(node.value, inner);
  return keys.length > 0 && keys.every((key) => document.keys.has(key)) ? keys : null;
}

function draftBlocks(
  draft: string,
  root: MarkdownDocument,
  document: DocumentBlocks,
): DraftBlock[] {
  const blocks: DraftBlock[] = [];
  for (const node of root.children) {
    const range = rangeOf(node);
    if (!range) continue;
    const key = blockKey(draft.slice(range.start, range.end), node);
    const fenced = fencedCopy(node, document);
    const keys = fenced ?? (WORD.test(key) ? [key] : []);
    const copied = keys.every((entry) => document.keys.has(entry));
    blocks.push({
      ...range,
      copies: copied ? keys.length : null,
      first: copied && keys.some((entry) => document.first.has(entry)),
      last: copied && keys.some((entry) => document.last.has(entry)),
    });
  }
  return blocks;
}

/**
 * How many blocks at the start of `blocks` are a copy. A run of blocks
 * without words (a rule, say) passes, but the copy ends at its last worded block.
 */
function copiedRun(
  blocks: readonly DraftBlock[],
  edge: 'first' | 'last',
  leadingCopies = 0,
  leadingEdge = false,
): number {
  let copies = leadingCopies;
  let atEdge = leadingEdge;
  let run = 0;
  for (const [index, block] of blocks.entries()) {
    if (block.copies === null) break;
    if (block.copies === 0) continue;
    copies += block.copies;
    atEdge ||= block[edge];
    run = index + 1;
  }
  return copies >= 2 || atEdge ? run : 0;
}

/**
 * The draft without document text the model copied at its start and, for a
 * finished draft, at its end. An unfinished draft keeps its end: the last
 * block may be cut off mid-copy, and a continuation picks up from it.
 */
export function withoutDocumentEcho(
  draft: string,
  documentSource: string,
  { trailing = true }: { trailing?: boolean } = {},
): DocumentEchoResult {
  const unchanged = { text: draft, removed: false };
  if (!draft.trim()) return unchanged;
  const document = documentBlocks(documentSource);
  if (!document) return unchanged;
  const root = parse(draft);
  if (!root) return unchanged;
  const blocks = draftBlocks(draft, root, document);

  // Copied frontmatter sits before the first block and goes with the copy.
  const frontmatter =
    document.frontmatter !== null && frontmatterOf(draft) === document.frontmatter;
  const leading = frontmatter ? copiedRun(blocks, 'first', 1, true) : copiedRun(blocks, 'first');
  const rest = blocks.slice(leading);
  const end = trailing ? rest.length - copiedRun([...rest].reverse(), 'last') : rest.length;
  if (!frontmatter && leading === 0 && end === rest.length) return unchanged;

  const kept = rest.slice(0, end);
  const firstKept = kept[0];
  const lastKept = kept.at(-1);
  if (!firstKept || !lastKept) return { text: '', removed: true };
  const start = leading > 0 || frontmatter ? firstKept.start : 0;
  const stop = end < rest.length ? lastKept.end : draft.length;
  return { text: draft.slice(start, stop), removed: true };
}
