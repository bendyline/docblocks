/**
 * Searchable text for one document: the rendered text, one entry per source
 * line, so a match maps back to the line it came from.
 *
 * Search runs over rendered text rather than raw Markdown so it agrees with
 * the editor's own find bar (`**Note:** foo` matches "Note: foo"). Each line
 * keeps the 1-based source line it started on.
 */

import type {
  MarkdownBlockNode,
  MarkdownDocument,
  MarkdownInlineNode,
  MarkdownListItem,
  MarkdownTableRow,
} from '@bendyline/squisq/markdown';
import type { WorkspaceSearchLineKind } from './types.js';

export interface SearchText {
  /** NFC-normalized rendered lines. */
  readonly lines: readonly string[];
  /** 1-based source line for each entry in `lines`. */
  readonly sourceLines: readonly number[];
  readonly kinds: readonly WorkspaceSearchLineKind[];
  /** Total UTF-16 code units across `lines`. */
  readonly characters: number;
}

class LineBuilder {
  private readonly lines: string[] = [];
  private readonly sourceLines: number[] = [];
  private readonly kinds: WorkspaceSearchLineKind[] = [];
  private current: string | null = null;
  private currentLine = 0;
  private kind: WorkspaceSearchLineKind = 'text';

  /** Start a new block: whatever follows begins on a fresh line. */
  public block(kind: WorkspaceSearchLineKind): void {
    this.flush();
    this.kind = kind;
  }

  /** Append text that starts on `line`, opening a new line when it advances. */
  public append(line: number, text: string): void {
    if (this.current === null || line > this.currentLine) {
      this.flush();
      this.current = '';
      this.currentLine = line;
    }
    this.current += text;
  }

  /** Text whose embedded newlines are source line breaks (soft breaks, code). */
  public appendLines(firstLine: number, value: string): void {
    const parts = value.split('\n');
    for (let index = 0; index < parts.length; index += 1) {
      this.append(firstLine + index, parts[index]!);
    }
  }

  public flush(): void {
    if (this.current !== null && this.current.trim() !== '') {
      this.lines.push(this.current.normalize('NFC'));
      this.sourceLines.push(this.currentLine);
      this.kinds.push(this.kind);
    }
    this.current = null;
  }

  public build(): SearchText {
    this.flush();
    let characters = 0;
    for (const line of this.lines) characters += line.length;
    return {
      lines: this.lines,
      sourceLines: this.sourceLines,
      kinds: this.kinds,
      characters,
    };
  }
}

/** Atoms the editor renders as widgets rather than searchable text. */
const UNSEARCHABLE_INLINE = new Set([
  'image',
  'imageReference',
  'inlineIcon',
  'htmlInline',
  'mention',
  'footnoteReference',
]);

function startLine(node: { readonly position?: { readonly start: { readonly line: number } } }) {
  return node.position?.start.line;
}

function emitInline(nodes: readonly MarkdownInlineNode[], out: LineBuilder, fallback: number) {
  for (const node of nodes) {
    if (UNSEARCHABLE_INLINE.has(node.type)) continue;
    const line = startLine(node) ?? fallback;
    if ('children' in node && Array.isArray(node.children)) {
      emitInline(node.children as MarkdownInlineNode[], out, line);
    } else if ('value' in node && typeof node.value === 'string') {
      out.appendLines(line, node.value);
    }
  }
}

function emitTableRow(row: MarkdownTableRow, out: LineBuilder, fallback: number) {
  const line = startLine(row) ?? fallback;
  row.children.forEach((cell, index) => {
    if (index > 0) out.append(line, ' | ');
    emitInline(cell.children, out, startLine(cell) ?? line);
  });
}

/** First line of a fenced block's content: one past the fence when there is one. */
function contentStartLine(line: number, sourceLines: readonly string[], fences: RegExp): number {
  return fences.test(sourceLines[line - 1] ?? '') ? line + 1 : line;
}

const CODE_FENCE = /^\s{0,3}(?:```|~~~)/u;
const MATH_FENCE = /^\s*\$\$/u;

function emitBlocks(
  blocks: readonly (MarkdownBlockNode | MarkdownListItem)[],
  out: LineBuilder,
  sourceLines: readonly string[],
  fallback: number,
) {
  for (const block of blocks) {
    const line = startLine(block) ?? fallback;
    switch (block.type) {
      case 'heading':
        out.block('heading');
        emitInline(block.children, out, line);
        break;
      case 'paragraph':
        out.block('text');
        emitInline(block.children, out, line);
        break;
      case 'leafDirective':
        out.block('text');
        emitInline(block.children, out, line);
        break;
      case 'code':
        out.block('code');
        out.appendLines(contentStartLine(line, sourceLines, CODE_FENCE), block.value);
        break;
      case 'math':
        out.block('code');
        out.appendLines(contentStartLine(line, sourceLines, MATH_FENCE), block.value);
        break;
      case 'table':
        for (const row of block.children) {
          out.block('text');
          emitTableRow(row, out, line);
        }
        break;
      case 'htmlBlock':
        // The editor renders the HTML, so search its text, not its tags.
        out.block('text');
        out.appendLines(line, block.rawHtml.replace(/<[^>]*>/gu, ' '));
        break;
      case 'definitionList':
        for (const item of block.children) {
          if (item.type === 'definitionTerm') {
            out.block('text');
            emitInline(item.children, out, startLine(item) ?? line);
          } else {
            emitBlocks(item.children, out, sourceLines, startLine(item) ?? line);
          }
        }
        break;
      case 'blockquote':
      case 'list':
      case 'listItem':
      case 'footnoteDefinition':
      case 'containerDirective':
        emitBlocks(block.children, out, sourceLines, line);
        break;
      case 'thematicBreak':
      case 'definition':
        break;
    }
  }
}

/** Frontmatter lines at their exact source positions; the parser drops them from the tree. */
function emitFrontmatter(sourceLines: readonly string[], out: LineBuilder) {
  if (sourceLines[0]?.trim() !== '---') return;
  for (let index = 1; index < sourceLines.length; index += 1) {
    const text = sourceLines[index]!;
    if (text.trim() === '---' || text.trim() === '...') return;
    out.block('frontmatter');
    out.append(index + 1, text);
  }
}

/** Rendered, line-mapped text of a parsed document. */
export function extractSearchText(document: MarkdownDocument, source: string): SearchText {
  const sourceLines = source.split('\n');
  const out = new LineBuilder();
  emitFrontmatter(sourceLines, out);
  emitBlocks(document.children, out, sourceLines, 1);
  return out.build();
}

/** Raw source lines, for documents too large or too deeply nested to parse. */
export function lineSearchText(source: string): SearchText {
  const out = new LineBuilder();
  source.split('\n').forEach((text, index) => {
    out.block('text');
    out.append(index + 1, text);
  });
  return out.build();
}
