import { expect } from 'chai';
import { kokoroDurationFrames, kokoroWordTimings } from '../main/speech/kokoro-timing.js';
import type { KokoroUtterance } from '../main/speech/kokoro-frontend.js';

describe('Kokoro model word allocations', () => {
  const utterance: KokoroUtterance = {
    textStart: 10,
    textEnd: 19,
    phonemes: 'ab c',
    tokens: [0, 1, 2, 3, 4, 0],
    words: [
      { textStart: 10, textEnd: 13, tokenStart: 1, tokenEnd: 3 },
      { textStart: 14, textEnd: 19, tokenStart: 4, tokenEnd: 5 },
    ],
  };
  const predictions = new Float32Array([2.5, 0.3, 3.5, 1.5, 4.5, 0]);

  it('uses ONNX ties-to-even rounding and minimum-one clipping', () => {
    expect([0, 0.5, 1.5, 2.5, 3.5, 4.5, 3.6].map(kokoroDurationFrames)).to.deep.equal([
      1, 1, 2, 2, 4, 4, 4,
    ]);
  });

  it('accounts for padding and spaces without assigning them to words', () => {
    expect(kokoroWordTimings(utterance, predictions, 8400)).to.deep.equal([
      { textStart: 10, textEnd: 13, startSec: 0.05, endSec: 0.175 },
      { textStart: 14, textEnd: 19, startSec: 0.225, endSec: 0.325 },
    ]);
  });

  it('omits timings if duration output is absent, invalid or inconsistent with PCM', () => {
    for (const invalid of [
      undefined,
      [2, 1, 4, 2, 4, 1],
      predictions.slice(1),
      new Float32Array([2, 1, NaN, 2, 4, 1]),
      new Float32Array([2, 1, -1, 2, 4, 1]),
    ]) {
      expect(kokoroWordTimings(utterance, invalid, 8400)).to.equal(undefined);
    }
    expect(kokoroWordTimings(utterance, predictions, 8401)).to.equal(undefined);
  });
});
