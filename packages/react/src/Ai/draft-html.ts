/**
 * HTML a model wrote where it was asked for Markdown.
 *
 * Asked for Markdown, Apple's on-device model on an iPad wrote a whole Add
 * content draft as `<document>`, `<section>`, `<h2>` and `<p>` elements, which
 * reached the editor as literal tags. The prompt's own `<document>` delimiters
 * invite that, and a prompt rule alone does not reliably stop a small model, so
 * the reply is also rewritten here.
 *
 * Only blocks that open with an element Markdown has syntax for are rewritten,
 * a run of them at a time, so a list split across blank lines converts whole.
 * Markdown blocks between them, fenced code, inline HTML inside a Markdown
 * paragraph and SVG pictures are left as written. A document with HTML blocks
 * of its own keeps the reply's, since matching its style may be the point.
 */

import { htmlToMarkdown } from '@bendyline/squisq-formats/html';

/**
 * A block opening with an element Markdown can say without HTML, or a wrapper
 * that holds nothing but such blocks. `document` is the prompt's delimiter.
 */
const HTML_BLOCK =
  /^[ ]{0,3}<\/?(?:h[1-6]|p|ul|ol|li|blockquote|pre|table|thead|tbody|tfoot|tr|th|td|hr|div|section|article|header|footer|main|aside|nav|body|html|document|dl|dt|dd)(?=[\s/>])/iu;
const FENCE_OPEN = /^[ ]{0,3}(`{3,}|~{3,})/u;
const BLANK = /^[ \t]*$/u;
/** Squisq's picture syntax is SVG; the converter drops it, so a run holding one is kept. */
const SVG = /<svg[\s>]/iu;
/**
 * Escapes the converter adds that a model asked for Markdown did not mean:
 * `<p>Some **bold** [1]</p>` meant the bold and the citation. `$` (Squisq
 * math), `<`, `>`, `&` and `|` (table cells) stay escaped.
 */
const UNMEANT_ESCAPE = /\\([*_`[\]#~.+\-!()])/gu;

interface Block {
  /** First line. */
  readonly start: number;
  /** One past the last line. */
  readonly end: number;
  readonly html: boolean;
}

/** Blank-line-separated blocks outside fenced code; a fence is one block that is never HTML. */
function blocks(lines: readonly string[]): Block[] {
  const found: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (BLANK.test(line)) {
      index += 1;
      continue;
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const close = new RegExp(
        `^[ ]{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`,
        'u',
      );
      let end = index + 1;
      while (end < lines.length && !close.test(lines[end] ?? '')) end += 1;
      found.push({ start: index, end: Math.min(end + 1, lines.length), html: false });
      index = end + 1;
      continue;
    }
    let end = index + 1;
    while (
      end < lines.length &&
      !BLANK.test(lines[end] ?? '') &&
      !FENCE_OPEN.test(lines[end] ?? '')
    )
      end += 1;
    found.push({ start: index, end, html: HTML_BLOCK.test(line) });
    index = end;
  }
  return found;
}

function convert(html: string): string {
  const markdown = htmlToMarkdown(html, { headMetadata: false, embeddedDocs: false }).trim();
  // A backslash the model wrote may be one it meant; then none is undone.
  return html.includes('\\') ? markdown : markdown.replace(UNMEANT_ESCAPE, '$1');
}

/** True when `markdown` has a block opening with an HTML element Markdown has syntax for. */
export function hasHtmlBlocks(markdown: string): boolean {
  return blocks(markdown.split('\n')).some((block) => block.html);
}

/**
 * `text` with each run of HTML blocks rewritten as Markdown, or `text` itself
 * when it has none (or `existing`, the document, has HTML blocks of its own).
 */
export function htmlBlocksToMarkdown(text: string, existing = ''): string {
  const lines = text.split('\n');
  const found = blocks(lines);
  if (!found.some((block) => block.html) || hasHtmlBlocks(existing)) return text;
  const out: string[] = [];
  let line = 0;
  for (let index = 0; index < found.length; ) {
    const block = found[index];
    if (!block?.html) {
      index += 1;
      continue;
    }
    let last = index;
    while (found[last + 1]?.html) last += 1;
    const end = found[last]?.end ?? block.end;
    const run = lines.slice(block.start, end).join('\n');
    out.push(...lines.slice(line, block.start));
    const markdown = SVG.test(run) ? run : convert(run);
    if (markdown) out.push(...markdown.split('\n'));
    // A wrapper alone, such as `</section>`, converts to nothing; the blank
    // lines after it still separate its neighbours, so drop those before it.
    else while (out.length > 0 && BLANK.test(out[out.length - 1] ?? '')) out.pop();
    line = end;
    index = last + 1;
  }
  out.push(...lines.slice(line));
  return out.join('\n').trim();
}
