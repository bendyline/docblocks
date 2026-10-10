import type { SpeechWordTiming } from '@bendyline/docblocks/host';
import type { KokoroUtterance } from './kokoro-frontend.js';

/** Timestamped Kokoro exposes predictions before ONNX Round (ties-to-even) and Clip. */
export function kokoroDurationFrames(prediction: number): number {
  const lower = Math.floor(prediction);
  return Math.max(1, prediction - lower === 0.5 ? lower + (lower % 2) : Math.round(prediction));
}

/** Missing or inconsistent metadata falls back to estimated timing without losing audio. */
export function kokoroWordTimings(
  utterance: KokoroUtterance,
  predictions: unknown,
  sampleCount: number,
): readonly SpeechWordTiming[] | undefined {
  if (!(predictions instanceof Float32Array) || predictions.length !== utterance.tokens.length)
    return undefined;
  const boundaries = [0];
  let frames = 0;
  for (const prediction of predictions) {
    if (!Number.isFinite(prediction) || prediction < 0) return undefined;
    frames += kokoroDurationFrames(prediction);
    boundaries.push(frames);
  }
  // This graph emits 600 PCM samples per allocated frame at 24 kHz.
  if (frames * 600 !== sampleCount) return undefined;
  return utterance.words.map((word) => ({
    textStart: word.textStart,
    textEnd: word.textEnd,
    startSec: boundaries[word.tokenStart]! / 40,
    endSec: boundaries[word.tokenEnd]! / 40,
  }));
}
