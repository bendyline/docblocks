import { expect } from 'chai';

import {
  buildReviewFollowUp,
  buildReviewRequest,
  buildReviewRequests,
} from '../src/Ai/ai-assistant.js';
import { reviewPartCharacters, splitReviewParts } from '../src/Ai/review-parts.js';

const SENTENCE = 'The team reviewed the plan and agreed on the next steps. ';

function paragraphs(count: number, sentences = 4): string[] {
  return Array.from(
    { length: count },
    (_, index) => `Paragraph ${index + 1}: ${SENTENCE.repeat(sentences).trim()}`,
  );
}

/** A lone half of a surrogate pair, which no quote typed from the document could match. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

describe('review parts', () => {
  it('sizes parts by the context window, treating an unknown window as 4K', () => {
    // Apple's on-device model: a 4,096-token window, about 1,400 characters of prompt.
    const apple = reviewPartCharacters(4_096, 1_400);
    expect(apple).to.be.within(5_000, 8_000);
    expect(reviewPartCharacters(null, 1_400)).to.equal(apple);
    expect(reviewPartCharacters(0, 1_400)).to.equal(apple);
    // A longer brief leaves less room for the document.
    expect(reviewPartCharacters(4_096, 2_400)).to.be.below(apple);
    expect(reviewPartCharacters(128_000, 1_400)).to.be.above(300_000);
    // Never so small that a part holds less than a few paragraphs.
    expect(reviewPartCharacters(1_024, 1_400)).to.equal(1_200);
  });

  it('keeps a document that fits whole', () => {
    const markdown = '# Notes\n\nOne paragraph.\n';
    expect(splitReviewParts(markdown, 1_000)).to.deep.equal(['# Notes\n\nOne paragraph.']);
  });

  it('cuts between paragraphs into parts that fit, each an exact excerpt of the document', () => {
    const markdown = ['# Report', ...paragraphs(40)].join('\n\n');
    const parts = splitReviewParts(markdown, 1_500);
    expect(parts.length).to.be.greaterThan(5);
    for (const part of parts) {
      expect(part.length).to.be.at.most(1_500);
      expect(markdown).to.contain(part);
    }
    // Every paragraph, whole, in exactly one part, in document order.
    for (const paragraph of paragraphs(40)) {
      expect(
        parts.filter((part) => part.includes(paragraph)),
        paragraph,
      ).to.have.length(1);
    }
    const order = parts.map((part) => Number(/Paragraph (\d+):/u.exec(part)?.[1]));
    expect(order).to.deep.equal([...order].sort((a, b) => a - b));
  });

  it('starts a part at a heading once the part is mostly full', () => {
    const markdown = [...paragraphs(4), '## Next section', ...paragraphs(4)].join('\n\n');
    // Four paragraphs fill about 80 percent of a part, so the heading starts the next.
    const parts = splitReviewParts(markdown, 1_200);
    expect(parts[1]?.startsWith('## Next section')).to.equal(true);
    expect(parts[0]).not.to.contain('## Next section');
  });

  it('never cuts inside a code fence, even across its blank lines', () => {
    const fence = ['```js', `// ${'a'.repeat(300)}`, '', '', `// ${'b'.repeat(300)}`, '```'].join(
      '\n',
    );
    const markdown = [...paragraphs(1), fence, ...paragraphs(1)].join('\n\n');
    // Read as blank-line blocks, the paragraph and the fence's first half fill
    // a part, and the cut would land inside the fence.
    const parts = splitReviewParts(markdown, 700);
    expect(parts.filter((part) => part.includes(fence))).to.have.length(1);
    expect(parts[0]).not.to.contain('```');
  });

  it('cuts an overlong paragraph after a sentence, and never through a character', () => {
    const long = `Intro: ${SENTENCE.repeat(40).trim()}`;
    const parts = splitReviewParts(long, 500);
    expect(parts.length).to.be.greaterThan(4);
    for (const part of parts) {
      expect(part.length).to.be.at.most(500);
      expect(long).to.contain(part);
      expect(part.endsWith('.')).to.equal(true);
    }

    const emoji = '😀'.repeat(600);
    for (const part of splitReviewParts(emoji, 301)) {
      expect(LONE_SURROGATE.test(part)).to.equal(false);
      expect(emoji).to.contain(part);
    }
  });

  it('sends one request for a document that fits, and numbered parts for one that does not', () => {
    const short = '# Notes\n\nOne paragraph.';
    expect(buildReviewRequests(short, 'concise', 4_096)).to.deep.equal([
      buildReviewRequest(short, 'concise'),
    ]);

    const long = ['# Quarterly report', ...paragraphs(80)].join('\n\n');
    expect(buildReviewRequests(long, 'general', 128_000)).to.have.length(1);
    const requests = buildReviewRequests(long, 'general', 4_096);
    expect(requests.length).to.be.greaterThan(2);
    const system = buildReviewRequest(long, 'general').messages[0]?.content;
    for (const [index, request] of requests.entries()) {
      expect(request.messages[0]?.content).to.equal(system);
      const user = request.messages[1]?.content ?? '';
      expect(user).to.contain(
        `This is part ${index + 1} of ${requests.length} of a longer Markdown document titled "Quarterly report".`,
      );
      expect(user).to.contain('do not report anything as missing from it');
      const characters = request.messages.reduce((sum, message) => sum + message.content.length, 0);
      // Prompt, reply and a margin all inside Apple's window.
      expect(characters / 3 + 1_200 + 150).to.be.at.most(4_096);
    }
    // A longer brief means more, smaller parts.
    expect(buildReviewRequests(long, 'un', 4_096).length).to.be.at.least(requests.length);
  });

  it('leaves room in every part to ask again with the passages already reported', () => {
    const long = ['# Quarterly report', ...paragraphs(80)].join('\n\n');
    const reported = paragraphs(40).map((paragraph) => `${paragraph} ${SENTENCE}`);
    for (const style of ['general', 'un'] as const) {
      for (const request of buildReviewRequests(long, style, 4_096)) {
        const followUp = buildReviewFollowUp(request, reported);
        const characters = followUp.messages.reduce(
          (sum, message) => sum + message.content.length,
          0,
        );
        expect(characters / 3 + 1_200 + 150).to.be.at.most(4_096);
        const listed = followUp.messages.at(-1)?.content ?? '';
        // The most recent passages are listed; the oldest give way.
        expect(listed).to.contain('- "Paragraph 40:');
        expect(listed).not.to.contain('- "Paragraph 1:');
        expect(listed.startsWith(request.messages.at(-1)?.content ?? '')).to.equal(true);
      }
    }
  });

  it('asks a small model for a few findings per part, and a larger one for all of them', () => {
    const long = ['# Quarterly report', ...paragraphs(80)].join('\n\n');
    // Apple's reply stops at 1,024 tokens: room for about six.
    for (const request of buildReviewRequests(long, 'general', 4_096)) {
      expect(request.messages[0]?.content).to.contain('with at most 6 objects');
    }
    expect(buildReviewRequests(long, 'general', null)[0]?.messages[0]?.content).to.contain(
      'with at most 6 objects',
    );
    const large = buildReviewRequests(long, 'general', 128_000)[0]?.messages[0]?.content;
    expect(large).to.contain('with one object for each meaningful issue you find');
    expect(large).not.to.contain('at most');
  });
});
