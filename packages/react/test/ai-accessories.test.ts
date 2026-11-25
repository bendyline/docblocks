/**
 * Side information kept in a document (Squisq accessory blocks: slide
 * summaries, study cards) is not its writing: Review and Compose prompts
 * leave it out, a quote inside it never locates a finding, Illustrate never
 * draws it, and it is never the document's title.
 */
import { expect } from 'chai';
import { ACCESSORY_BLOCK_TYPES } from '@bendyline/squisq/doc';
import { sideInformationRanges, withoutSideInformation } from '../src/Ai/ai-accessories.js';
import { buildReviewRequest, findUniqueExcerpt } from '../src/Ai/ai-assistant.js';
import { segmentPassages } from '../src/Ai/illustrate-passages.js';
import { SIDE_INFORMATION_TAGS, documentTitle } from '../src/Ai/document-title.js';

const DOC = [
  '# Plants',
  '',
  'Plants turn light into sugar in their leaves.',
  '',
  '## Where does it happen? {[quiz origin=ai]}',
  '',
  '- [ ] In the roots',
  '- [x] In the leaves',
  '',
  'Plants turn light into sugar in their leaves.',
  '',
  '## Watering',
  '',
  'Water in the morning.',
].join('\n');

describe('side information in AI prompts', () => {
  it('leaves study cards out of the document a model is shown', () => {
    const own = withoutSideInformation(DOC);
    expect(own).to.not.contain('Where does it happen?');
    expect(own).to.contain('Water in the morning.');
    expect(sideInformationRanges(DOC)).to.have.length(1);
    expect(withoutSideInformation('# Plain\n\nText.')).to.equal('# Plain\n\nText.');
    const review = buildReviewRequest(DOC);
    expect(review.messages.map((message) => message.content).join('\n')).to.not.contain(
      'In the roots',
    );
  });

  it('locates a finding by the author’s text, not a copy inside a card', () => {
    const found = findUniqueExcerpt(DOC, 'Plants turn light into sugar in their leaves.');
    expect(found).to.not.equal(null);
    expect(found!.start).to.equal(DOC.indexOf('Plants turn light'));
  });

  it('never makes a picture from a card', () => {
    const passages = segmentPassages(DOC, { everyBlock: true });
    expect(passages.map((passage) => passage.text).join('\n')).to.not.contain('In the roots');
  });

  it('never takes a card for the title, and knows every kind of side information', () => {
    expect(documentTitle('## A slide {[summary]}\n\n- Point\n\n# Real title\n\nText.')).to.equal(
      'Real title',
    );
    expect([...SIDE_INFORMATION_TAGS].sort()).to.deep.equal(
      Object.keys(ACCESSORY_BLOCK_TYPES).sort(),
    );
  });
});
