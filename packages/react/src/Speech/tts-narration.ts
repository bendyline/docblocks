/**
 * Timing for narration DocBlocks synthesized itself.
 *
 * Recorded narration has to be aligned to the script after the fact. Generated
 * narration does not: every sentence was synthesized on its own, so where each
 * one starts and ends in the audio is known exactly. Words inside a sentence
 * are placed by syllable count, which is how Squisq's own aligner interpolates
 * words it could not hear. The result is a `NarrationAlignment`, so the
 * existing save path writes the same v3 sidecar recorded narration produces,
 * stamped `method: 'tts'`.
 */

import type {
  NarrationAlignment,
  NarrationBlockRange,
  NarrationScript,
  WordTiming,
} from '@bendyline/squisq/narration';

/** Where one synthesized chunk landed: its script range and its audio span. */
export interface SpokenSpan {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly startSec: number;
  readonly endSec: number;
}

/** Build word and block timings for a script from the spans that spoke it. */
export function buildTtsAlignment(
  script: NarrationScript,
  spans: readonly SpokenSpan[],
  durationSec: number,
): NarrationAlignment {
  // Spans are spoken in source order, so one pass assigns every token a span.
  const ordered = [...spans].sort((a, b) => a.sourceStart - b.sourceStart);
  const spanOf: number[] = new Array<number>(script.tokens.length).fill(-1);
  let cursor = 0;
  for (const [tokenIndex, token] of script.tokens.entries()) {
    while (cursor < ordered.length && ordered[cursor]!.sourceEnd <= token.charOffset) cursor += 1;
    const span = ordered[cursor];
    if (span && token.charOffset >= span.sourceStart) spanOf[tokenIndex] = cursor;
  }
  // Syllable totals per span, then each token's share of its span's time.
  const totals = new Array<number>(ordered.length).fill(0);
  for (const [tokenIndex, token] of script.tokens.entries()) {
    const span = spanOf[tokenIndex]!;
    if (span >= 0) totals[span]! += Math.max(1, token.syllables);
  }
  const consumed = new Array<number>(ordered.length).fill(0);
  const words: WordTiming[] = [];
  let lastTime = 0;
  for (const [tokenIndex, token] of script.tokens.entries()) {
    const index = spanOf[tokenIndex]!;
    if (index < 0) {
      // Never spoken (e.g. a lone symbol between segments): it takes the time
      // of whatever is spoken next, so timing stays monotonic.
      const next = ordered.find((candidate) => candidate.sourceStart > token.charOffset);
      lastTime = Math.max(lastTime, next?.startSec ?? durationSec);
      words.push({ tokenIndex, tSec: lastTime, interpolated: true });
      continue;
    }
    const span = ordered[index]!;
    const before = consumed[index]!;
    consumed[index] = before + Math.max(1, token.syllables);
    const t =
      span.startSec + (span.endSec - span.startSec) * (before / Math.max(1, totals[index]!));
    lastTime = Math.max(lastTime, t);
    words.push({ tokenIndex, tSec: lastTime, interpolated: before > 0 });
  }

  const blocks: NarrationBlockRange[] = [];
  for (const [blockIndex, block] of script.blocks.entries()) {
    const first = words[block.tokenStart];
    blocks.push({
      blockId: block.blockId,
      ...(block.heading !== undefined ? { heading: block.heading } : {}),
      blockIndex,
      charStart: block.charStart,
      charEnd: block.charEnd,
      startSec: blockIndex === 0 ? 0 : (first?.tSec ?? 0),
      endSec: durationSec,
    });
  }
  // Ranges are contiguous: each block ends where the next begins.
  for (let i = 0; i < blocks.length - 1; i += 1) {
    const current = blocks[i]!;
    const next = blocks[i + 1]!;
    blocks[i] = { ...current, endSec: Math.max(current.startSec, next.startSec) };
  }

  return { words, blocks, detectedSyllables: 0, cost: 0 };
}
