import { expect } from 'chai';
import { planSpeech } from '../src/Speech/speakable-text.js';
import { buildTtsAlignment, type SpokenSpan } from '../src/Speech/tts-narration.js';
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
    // "Four" opens the fourth segment exactly; later words are interpolated.
    const four = plan.script.tokens.findIndex((token) => token.text === 'Four');
    expect(alignment.words[four]).to.deep.equal({ tokenIndex: four, tSec: 6, interpolated: false });
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
});
