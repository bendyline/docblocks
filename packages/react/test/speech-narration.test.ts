import { expect } from 'chai';
import { planSpeech } from '../src/Speech/speakable-text.js';
import {
  buildTtsAlignment,
  spokenSpanForChunk,
  type SpokenSpan,
} from '../src/Speech/tts-narration.js';
import { buildNarrationSavePlan } from '@bendyline/squisq-editor-react/teleprompter';
import { hasDocumentNarration } from '../src/Speech/useGenerateNarration.js';

describe('generated narration timing', () => {
  it('places every word inside the span that spoke it, monotonically', async () => {
    const plan = await planSpeech('# Intro\n\nOne two three.\n\n## Next\n\nFour five six seven.');
    // One span per segment, two seconds each, in order.
    const spans: SpokenSpan[] = plan.segments.map((segment, index) => ({
      sourceStart: segment.sourceStart,
      sourceEnd: segment.sourceEnd,
      startSec: index * 2,
      endSec: index * 2 + 2,
    }));
    const duration = spans.length * 2;
    const alignment = buildTtsAlignment(plan.script, spans, duration);

    expect(alignment.words).to.have.length(plan.script.tokens.length);
    for (let i = 1; i < alignment.words.length; i += 1) {
      expect(alignment.words[i]!.tSec).to.be.at.least(alignment.words[i - 1]!.tSec);
    }
    // All word timings are estimates when the engine supplies only chunks.
    const four = plan.script.tokens.findIndex((token) => token.text === 'Four');
    expect(alignment.words[four]).to.deep.equal({ tokenIndex: four, tSec: 6, interpolated: true });
    const seven = plan.script.tokens.findIndex((token) => token.text.startsWith('seven'));
    expect(alignment.words[seven]!.tSec).to.be.within(6, 8);
    expect(alignment.words[seven]!.interpolated).to.equal(true);

    // Blocks are contiguous and cover the whole take.
    expect(alignment.blocks).to.have.length(plan.script.blocks.length);
    expect(alignment.blocks[0]!.startSec).to.equal(0);
    expect(alignment.blocks.at(-1)!.endSec).to.equal(duration);
    for (let i = 0; i < alignment.blocks.length - 1; i += 1) {
      expect(alignment.blocks[i]!.endSec).to.equal(alignment.blocks[i + 1]!.startSec);
    }
    expect(alignment.blocks[1]!.startSec).to.equal(4);
  });

  it('gives unspoken tokens the time of the next spoken word', async () => {
    const plan = await planSpeech('Alpha beta.\n\nGamma delta.');
    const second = plan.segments[1]!;
    const alignment = buildTtsAlignment(
      plan.script,
      [{ sourceStart: second.sourceStart, sourceEnd: second.sourceEnd, startSec: 0, endSec: 1 }],
      1,
    );
    expect(alignment.words[0]).to.deep.equal({ tokenIndex: 0, tSec: 0, interpolated: true });
  });

  it('recognises a document-anchored narration line', () => {
    expect(
      hasDocumentNarration('{[audio src=audio/narration.webm anchor=document]}\n\n# Hi'),
    ).to.equal(true);
    expect(hasDocumentNarration('{[audio src=clip.mp3]}\n\n# Hi')).to.equal(false);
  });

  it('saves model allocations with source and audio offsets, including currency expansions', async () => {
    const plan = await planSpeech('Intro.\n\nPay $3.50 now.');
    const segment = plan.segments[1]!;
    const span = spokenSpanForChunk(
      {
        index: 0,
        pcm: new ArrayBuffer(0),
        sampleRate: 24000,
        durationSec: 3,
        textStart: 0,
        textEnd: segment.text.length,
        wordTimings: [
          { textStart: 0, textEnd: 3, startSec: 0.1, endSec: 0.3 },
          ...[0.4, 0.7, 1, 1.3].map((startSec) => ({
            textStart: 4,
            textEnd: 9,
            startSec,
            endSec: startSec + 0.2,
          })),
          { textStart: 10, textEnd: 13, startSec: 2.2, endSec: 2.8 },
        ],
      },
      segment,
      2,
    );
    const alignment = buildTtsAlignment(
      plan.script,
      [{ sourceStart: 0, sourceEnd: plan.segments[0]!.sourceEnd, startSec: 0, endSec: 2 }, span],
      5,
    );
    expect(alignment.words.map((word) => word.tSec)).to.deep.equal([0, 2.1, 2.4, 4.2]);
    expect(alignment.words.map((word) => word.interpolated)).to.deep.equal([
      true,
      false,
      false,
      false,
    ]);
    const save = buildNarrationSavePlan({
      script: plan.script,
      alignment,
      durationSec: 5,
      audioExt: '.webm',
      cameraExt: null,
      generator: { name: 'docblocks-kokoro', method: 'tts' },
    });
    const sidecar = JSON.parse(JSON.stringify(save.sidecarPayload));
    expect(sidecar.bookmarks.map((word: { time: number }) => word.time)).to.deep.equal([
      0, 2.1, 2.4, 4.2,
    ]);
    expect(sidecar.bookmarks.map((word: { charOffset: number }) => word.charOffset)).to.deep.equal(
      plan.script.tokens.map((word) => word.charOffset),
    );
    expect(sidecar.duration).to.equal(5);
  });

  it('keeps the first onset when a word spans chunks and handles quoted tokens', async () => {
    const plan = await planSpeech('“Hello” world.');
    const alignment = buildTtsAlignment(
      plan.script,
      [
        {
          sourceStart: 1,
          sourceEnd: 6,
          startSec: 0,
          endSec: 1,
          wordTimings: [{ textStart: 1, textEnd: 6, startSec: 0.2, endSec: 0.9 }],
        },
        {
          sourceStart: 1,
          sourceEnd: 14,
          startSec: 1,
          endSec: 3,
          wordTimings: [
            { textStart: 1, textEnd: 6, startSec: 1.1, endSec: 1.5 },
            { textStart: 8, textEnd: 13, startSec: 2, endSec: 2.8 },
          ],
        },
      ],
      3,
    );
    expect(alignment.words.map((word) => word.tSec)).to.deep.equal([0.2, 2]);
    expect(alignment.words.every((word) => !word.interpolated)).to.equal(true);
  });
});
