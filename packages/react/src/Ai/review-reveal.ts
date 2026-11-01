/**
 * Select a range of the Markdown source in whichever editor is showing.
 *
 * The Source view shows the source itself, so offsets map straight through.
 * The Write view shows a ProseMirror document, and Squisq publishes no
 * mapping from a source offset to a ProseMirror position: the range's visible
 * text is found there instead, and when that text occurs more than once, the
 * copy is chosen by counting how often it appears earlier in the source.
 */

import type { EditorContextValue, EditorView } from '@bendyline/squisq-editor-react';

type WriteEditor = NonNullable<EditorContextValue['tiptapEditor']>;
type SourceEditor = NonNullable<EditorContextValue['monacoEditor']>;
type ProseMirrorDoc = WriteEditor['state']['doc'];

interface Span {
  readonly from: number;
  readonly to: number;
}

/** Where the body starts: the Write view does not show frontmatter. */
function bodyStart(source: string): number {
  return /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u.exec(source)?.[0].length ?? 0;
}

/**
 * A line of Markdown as the Write view shows its text: without block markers,
 * inline markup, link targets, pictures or block annotations. Approximate by
 * design; when it is off, matching retries with fewer words.
 */
export function visibleLine(line: string): string {
  return (
    line
      .replace(/^\s{0,3}(?:>\s?)*(?:#{1,6}\s+)?/u, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/u, '')
      .replace(/\s*\{\[[^\]]*\]\}\s*$/u, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
      .replace(/\[([^\]]+)\]\[[^\]]*\]/gu, '$1')
      .replace(/<\/?[A-Za-z][^>]*>/gu, '')
      .replace(/\*\*|__|~~|\*|`/gu, '')
      // An underscore inside a word is text; at a word's edge it is emphasis.
      .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
  );
}

function visibleLines(markdown: string): string[] {
  return markdown.split('\n').map(visibleLine);
}

/** Every match of `query` within one text block of `doc`, in document order. */
function textMatches(doc: ProseMirrorDoc, query: string): Span[] {
  const matches: Span[] = [];
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    const spans: { from: number; to: number; at: number }[] = [];
    let text = '';
    block.descendants((child, offset) => {
      if (child.isText && child.text) {
        spans.push({
          from: text.length,
          to: text.length + child.text.length,
          at: blockPos + 1 + offset,
        });
        text += child.text;
      } else if (child.isInline) {
        // Never match across a picture or a hard break.
        text += '\u0000';
      }
      return true;
    });
    const position = (index: number, edge: 'start' | 'end') => {
      const span = spans.find((candidate) =>
        edge === 'start'
          ? index >= candidate.from && index < candidate.to
          : index > candidate.from && index <= candidate.to,
      );
      return span ? span.at + index - span.from : null;
    };
    for (let index = text.indexOf(query); index >= 0; index = text.indexOf(query, index + 1)) {
      const from = position(index, 'start');
      const to = position(index + query.length, 'end');
      if (from !== null && to !== null) matches.push({ from, to });
    }
    return false;
  });
  return matches;
}

function count(lines: readonly string[], query: string): number {
  let total = 0;
  for (const line of lines) {
    for (let index = line.indexOf(query); index >= 0; index = line.indexOf(query, index + 1)) {
      total += 1;
    }
  }
  return total;
}

/** `query`, then its first eight and first four words, for markup the stripping missed. */
function shorterQueries(query: string): string[] {
  const words = query.split(' ');
  return [query, words.slice(0, 8).join(' '), words.slice(0, 4).join(' ')].filter(
    (candidate, index, all) => candidate.length >= 3 && all.indexOf(candidate) === index,
  );
}

/**
 * The copy of `query` in `doc` that is the one after `earlier` lines of the
 * source, or null when `query` is not shown at all.
 */
function matchAfter(doc: ProseMirrorDoc, query: string, earlier: readonly string[]): Span | null {
  for (const candidate of shorterQueries(query)) {
    const matches = textMatches(doc, candidate);
    if (matches.length > 0) {
      return matches[Math.min(count(earlier, candidate), matches.length - 1)] ?? null;
    }
  }
  return null;
}

function selectInWrite(editor: WriteEditor, source: string, start: number, end: number): boolean {
  const body = bodyStart(source);
  const from = Math.max(start, body);
  const shown = visibleLines(source.slice(from, Math.max(from, end))).filter(Boolean);
  const earlier = visibleLines(source.slice(body, from));
  const doc = editor.state.doc;
  let range: Span | null;
  const first = shown[0];
  if (first) {
    const opening = matchAfter(doc, first, earlier);
    const last = shown.length > 1 ? shown[shown.length - 1] : undefined;
    const closing =
      opening && last
        ? textMatches(doc, last).find((match) => match.from >= opening.to)
        : undefined;
    range = opening && { from: opening.from, to: closing?.to ?? opening.to };
  } else {
    // Nothing visible left, as when the reviewed text was deleted: put the
    // caret just after whatever precedes where it was.
    const before = earlier.filter(Boolean);
    const previous = before[before.length - 1];
    const match = previous ? matchAfter(doc, previous, before.slice(0, -1)) : null;
    range = match && { from: match.to, to: match.to };
  }
  if (!range) return false;
  editor.chain().setTextSelection(range).focus(null, { scrollIntoView: false }).run();
  const { node } = editor.view.domAtPos(range.from);
  (node instanceof Element ? node : node.parentElement)?.scrollIntoView({ block: 'center' });
  return true;
}

function selectInSource(editor: SourceEditor, source: string, start: number, end: number): boolean {
  const model = editor.getModel();
  if (!model) return false;
  let from = start;
  let to = end;
  const value = model.getValue();
  if (value !== source) {
    // The Block layout shows one block, not the whole source.
    const excerpt = source.slice(start, end);
    const offset = excerpt ? value.indexOf(excerpt) : -1;
    if (offset < 0) return false;
    from = offset;
    to = offset + excerpt.length;
  }
  const head = model.getPositionAt(from);
  const tail = model.getPositionAt(to);
  const range = {
    startLineNumber: head.lineNumber,
    startColumn: head.column,
    endLineNumber: tail.lineNumber,
    endColumn: tail.column,
  };
  editor.setSelection(range);
  editor.revealRangeInCenterIfOutsideViewport(range);
  editor.focus();
  return true;
}

export interface RevealTarget {
  readonly activeView: EditorView;
  readonly tiptapEditor: EditorContextValue['tiptapEditor'];
  readonly monacoEditor: EditorContextValue['monacoEditor'];
}

/** Whether the editor for the active view is mounted, so a range can be selected in it. */
export function canReveal(target: RevealTarget): boolean {
  return (
    (target.activeView === 'wysiwyg' && target.tiptapEditor !== null) ||
    (target.activeView === 'raw' && target.monacoEditor !== null)
  );
}

/**
 * Select [start, end) of `source` in the active editor, scroll it into view
 * and focus it. False when the active view cannot show it.
 */
export function revealSourceRange(
  target: RevealTarget,
  source: string,
  start: number,
  end: number,
): boolean {
  if (target.activeView === 'raw' && target.monacoEditor) {
    return selectInSource(target.monacoEditor, source, start, end);
  }
  if (target.activeView === 'wysiwyg' && target.tiptapEditor) {
    return selectInWrite(target.tiptapEditor, source, start, end);
  }
  return false;
}
