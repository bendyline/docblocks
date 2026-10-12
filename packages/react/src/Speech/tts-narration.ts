/**
 * Timing for narration DocBlocks synthesized itself.
 *
 * Recorded narration has to be aligned to the script after the fact. Generated
 * narration carries model-derived word allocations when available. Older
 * engines fall back to syllable-weighted estimates within each audio chunk.
 * The result is a `NarrationAlignment`, so the
 * existing save path writes the same v3 sidecar recorded narration produces,
 * stamped `method: 'tts'`.
 */

import type {
  NarrationAlignment,
  NarrationBlockRange,
  NarrationScript,
  WordTiming,
} from '@bendyline/squisq/narration';
import type { SpeechAudioChunk, SpeechWordTiming } from '@bendyline/docblocks/host';

/** Where one synthesized chunk landed: its script range and its audio span. */
export interface SpokenSpan {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly startSec: number;
  readonly endSec: number;
  /** Absolute script offsets and audio times, after concatenating chunks. */
  readonly wordTimings?: readonly SpeechWordTiming[];
}

export function spokenSpanForChunk(
  chunk: SpeechAudioChunk,
  segment: { readonly sourceStart: number; readonly sourceEnd: number },
  elapsed: number,
): SpokenSpan {
  const length = segment.sourceEnd - segment.sourceStart;
  const sourceOffset = (offset: number) => segment.sourceStart + Math.min(offset, length);
  return {
    sourceStart: sourceOffset(chunk.textStart),
    sourceEnd: sourceOffset(chunk.textEnd),
    startSec: elapsed,
    endSec: elapsed + chunk.durationSec,
    ...(chunk.wordTimings !== undefined
      ? {
          wordTimings: chunk.wordTimings
            .map((word) => ({
              textStart: sourceOffset(word.textStart),
              textEnd: sourceOffset(word.textEnd),
              startSec: elapsed + word.startSec,
              endSec: elapsed + word.endSec,
            }))
            .filter((word) => word.textEnd > word.textStart),
        }
      : {}),
  };
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
  const modelWords = ordered.flatMap((span) => span.wordTimings ?? []);
  const modelTimes: Array<number | undefined> = [];
  let modelCursor = 0;
  for (const token of script.tokens) {
    while (modelCursor < modelWords.length && modelWords[modelCursor]!.textEnd <= token.charOffset)
      modelCursor++;
    const word = modelWords[modelCursor];
    // Expansions and words continued in the next chunk keep their earliest onset.
    modelTimes.push(word && word.textStart < token.charEnd ? word.startSec : undefined);
  }
  const nextModelTimes: number[] = [];
  let nextTime = durationSec;
  for (let i = modelTimes.length - 1; i >= 0; i--) {
    nextTime = modelTimes[i] ?? nextTime;
    nextModelTimes[i] = nextTime;
  }
  const words: WordTiming[] = [];
  let lastTime = 0;
  for (const [tokenIndex, token] of script.tokens.entries()) {
    const index = spanOf[tokenIndex]!;
    const modelTime = modelTimes[tokenIndex];
    const before = index >= 0 ? consumed[index]! : 0;
    if (index >= 0) consumed[index] = before + Math.max(1, token.syllables);
    if (modelTime !== undefined) {
      lastTime = Math.max(lastTime, modelTime);
      words.push({ tokenIndex, tSec: lastTime, interpolated: false });
      continue;
    }
    if (index < 0) {
      // Never spoken (e.g. a lone symbol between segments): it takes the time
      // of whatever is spoken next, so timing stays monotonic.
      const next = ordered.find((candidate) => candidate.sourceStart > token.charOffset);
      lastTime = Math.max(
        lastTime,
        Math.min(next?.startSec ?? durationSec, nextModelTimes[tokenIndex]!),
      );
      words.push({ tokenIndex, tSec: lastTime, interpolated: true });
      continue;
    }
    const span = ordered[index]!;
    const t =
      span.startSec + (span.endSec - span.startSec) * (before / Math.max(1, totals[index]!));
    lastTime = Math.max(lastTime, Math.min(t, nextModelTimes[tokenIndex]!));
    words.push({ tokenIndex, tSec: lastTime, interpolated: true });
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
