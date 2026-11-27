/**
 * A document's text as the workspace index keeps it: the person's writing,
 * without side information kept in the document (Squisq accessory blocks —
 * slide summaries, study cards). Ask, workspace grounding and search cite
 * what the index holds as the person's notes; an AI-written study card is
 * not, and a quiz's checklist is not a list of steps.
 *
 * The lines an accessory section takes are blanked rather than removed, so
 * every other line keeps its number and `#line=a-b` citations still point at
 * the right place in the file.
 */
import type { MarkdownBlockNode } from '@bendyline/squisq/markdown';

/** `source` with the lines of `dropped` (top-level nodes left out) blanked. */
export function blankDroppedLines(source: string, dropped: readonly MarkdownBlockNode[]): string {
  if (!dropped.length) return source;
  const lines = source.split('\n');
  for (const node of dropped) {
    const start = node.position?.start.line;
    const end = node.position?.end.line;
    if (start === undefined || end === undefined) continue;
    for (let line = start; line <= end; line++) lines[line - 1] = '';
  }
  return lines.join('\n');
}
