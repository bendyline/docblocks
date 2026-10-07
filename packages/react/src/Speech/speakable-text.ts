/**
 * Turn a document into the pieces narration speaks.
 *
 * Text comes from Squisq's narration script, the same model the teleprompter
 * and recorded narration use, so read-aloud, generated narration and recorded
 * takes all agree on block boundaries and ids. Two adjustments make it sound
 * right when synthesized:
 *
 * - Headings are spoken as their own segment with closing punctuation, so the
 *   voice pauses after a title instead of running it into the first sentence.
 * - Fenced code is left out; nobody wants a program read to them.
 */

import type { NarrationScript } from '@bendyline/squisq/narration';
import type { Doc } from '@bendyline/squisq/schemas';

export interface SpeechSegmentPlan {
  /** Exactly what is sent to the synthesizer. */
  readonly text: string;
  readonly blockId: string | null;
  readonly kind: 'heading' | 'body';
  /** Range in the narration script's `sourceText`. */
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

export interface SpeechPlan {
  /** The narration script text the segment ranges index into. */
  readonly sourceText: string;
  readonly segments: readonly SpeechSegmentPlan[];
  /** The doc the plan was built from, for callers that save narration. */
  readonly doc: Doc;
  /** The narration script the segment ranges index into. */
  readonly script: NarrationScript;
}

/** Keep each request well inside the host's per-request text bound. */
export const MAX_SEGMENT_CHARACTERS = 4_000;

const FENCE =
  /^(?<indent> {0,3})(?<marker>`{3,}|~{3,})[^\n]*\n[\s\S]*?^\k<indent>\k<marker>[ \t]*$/gmu;

/** Remove fenced code blocks, leaving the surrounding structure intact. */
export function stripFencedCode(markdown: string): string {
  return markdown.replace(FENCE, '');
}

/** Give a line closing punctuation so the voice ends it as a sentence. */
export function ensureSentenceEnd(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed) return trimmed;
  return /[.!?…:;]["'”’)\]]*$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Split an overlong body at sentence ends, then at spaces, under `max`. */
export function splitLongText(
  text: string,
  start: number,
  max = MAX_SEGMENT_CHARACTERS,
): Array<{ text: string; start: number; end: number }> {
  const pieces: Array<{ text: string; start: number; end: number }> = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + max);
    if (end < text.length) {
      const window = text.slice(offset, end);
      const sentence = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('! '),
        window.lastIndexOf('? '),
        window.lastIndexOf('\n'),
      );
      const space = window.lastIndexOf(' ');
      const cut = sentence > max / 4 ? sentence + 1 : space > max / 4 ? space : window.length;
      end = offset + cut;
    }
    const piece = text.slice(offset, end);
    const leading = piece.length - piece.trimStart().length;
    const trimmed = piece.trim();
    if (trimmed) {
      pieces.push({
        text: trimmed,
        start: start + offset + leading,
        end: start + offset + leading + trimmed.length,
      });
    }
    offset = end;
  }
  return pieces;
}

/** Build the speech plan for markdown: a whole document or a selection. */
export async function planSpeech(markdown: string): Promise<SpeechPlan> {
  const [{ parseMarkdown }, { markdownToDoc }, { buildNarrationScript }] = await Promise.all([
    import('@bendyline/squisq/markdown'),
    import('@bendyline/squisq/doc'),
    import('@bendyline/squisq/narration'),
  ]);
  const doc = markdownToDoc(parseMarkdown(stripFencedCode(markdown)));
  const script = buildNarrationScript(doc);
  const segments: SpeechSegmentPlan[] = [];
  for (const block of script.blocks) {
    const text = script.sourceText.slice(block.charStart, block.charEnd);
    let bodyStart = block.charStart;
    const heading = block.heading?.trim();
    if (heading && text.startsWith(heading)) {
      segments.push({
        text: ensureSentenceEnd(heading),
        blockId: block.blockId,
        kind: 'heading',
        sourceStart: block.charStart,
        sourceEnd: block.charStart + heading.length,
      });
      bodyStart = block.charStart + heading.length;
    }
    // One segment per line: paragraphs and list items each end as a sentence,
    // so an unpunctuated item never runs into the next.
    const lines = /[^\n]+/gu;
    const body = script.sourceText.slice(bodyStart, block.charEnd);
    for (const line of body.matchAll(lines)) {
      for (const piece of splitLongText(line[0], bodyStart + line.index)) {
        segments.push({
          text: ensureSentenceEnd(piece.text),
          blockId: block.blockId,
          kind: 'body',
          sourceStart: piece.start,
          sourceEnd: piece.end,
        });
      }
    }
  }
  return { sourceText: script.sourceText, segments, doc, script };
}
