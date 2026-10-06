import { expect } from 'chai';
import {
  ensureSentenceEnd,
  planSpeech,
  splitLongText,
  stripFencedCode,
} from '../src/Speech/speakable-text.js';

describe('speech planning', () => {
  it('speaks headings as their own sentence and keeps script offsets', async () => {
    const plan = await planSpeech(
      '# Introduction\n\nDocBlocks reads aloud.\n\n## Next steps\n\nTry it now',
    );
    const texts = plan.segments.map((s) => s.text);
    expect(texts).to.deep.equal([
      'Introduction.',
      'DocBlocks reads aloud.',
      'Next steps.',
      'Try it now.',
    ]);
    for (const segment of plan.segments) {
      const slice = plan.sourceText.slice(segment.sourceStart, segment.sourceEnd);
      expect(segment.text.startsWith(slice) || ensureSentenceEnd(slice) === segment.text).to.equal(
        true,
      );
      expect(segment.blockId).to.be.a('string');
    }
    expect(plan.segments[0]?.kind).to.equal('heading');
  });

  it('leaves fenced code out of what is spoken', async () => {
    const markdown = 'Before.\n\n```js\nconst secret = 42;\n```\n\nAfter.';
    expect(stripFencedCode(markdown)).to.not.contain('secret');
    const plan = await planSpeech(markdown);
    expect(plan.segments.map((s) => s.text).join(' ')).to.not.contain('secret');
    expect(plan.segments.map((s) => s.text).join(' ')).to.contain('After.');
  });

  it('closes unpunctuated lines but leaves punctuated ones alone', () => {
    expect(ensureSentenceEnd('A title')).to.equal('A title.');
    expect(ensureSentenceEnd('Done!')).to.equal('Done!');
    expect(ensureSentenceEnd('He said “hi.”')).to.equal('He said “hi.”');
    expect(ensureSentenceEnd('Items:')).to.equal('Items:');
  });

  it('splits overlong text at sentence ends with exact offsets', () => {
    const text = 'One two three. Four five six. Seven eight nine.';
    const pieces = splitLongText(text, 100, 20);
    expect(pieces.length).to.be.greaterThan(1);
    for (const piece of pieces) {
      expect(piece.text.length).to.be.at.most(20);
      expect(text.slice(piece.start - 100, piece.end - 100)).to.equal(piece.text);
    }
  });
});
