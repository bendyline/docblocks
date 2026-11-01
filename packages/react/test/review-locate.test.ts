import { expect } from 'chai';

import { locateReviewExcerpt } from '../src/Ai/review-locate.js';

const REVIEWED = [
  '# Migration notes',
  'Last quarter we evaluated three tools for the new team wiki.',
  'The results was mixed, and alot of pages had not been touched since 2021.',
  'DocBlocks stood out because it stores plain Markdown files.',
].join('\n\n');
const QUOTE = 'The results was mixed, and alot of pages had not been touched since 2021.';

function text(current: string, location: ReturnType<typeof locateReviewExcerpt>) {
  return location ? current.slice(location.start, location.end) : null;
}

describe('locating a review excerpt', () => {
  it('finds a quote that is still there, wherever it moved', () => {
    const current = `Intro added later.\n\n${REVIEWED}`;
    const location = locateReviewExcerpt(current, REVIEWED, QUOTE);
    expect(location?.exact).to.equal(true);
    expect(text(current, location)).to.equal(QUOTE);
  });

  it('picks the copy of a repeated quote nearest where the reviewed one was', () => {
    const reviewed =
      'Opening line of the page.\n\nSame words.\n\nMiddle of the page.\n\nSame words.';
    const current = `A new first paragraph.\n\n${reviewed}`;
    // The model's quote is the first copy, after the opening line.
    const location = locateReviewExcerpt(current, reviewed, 'Same words.');
    expect(location).to.deep.equal({
      start: current.indexOf('Same words.'),
      end: current.indexOf('Same words.') + 'Same words.'.length,
      exact: true,
    });
  });

  it('follows edited text by what surrounded it', () => {
    const edited = 'The results were mixed, and a lot of pages had not changed since 2021.';
    const current = REVIEWED.replace(QUOTE, edited);
    const location = locateReviewExcerpt(current, REVIEWED, QUOTE);
    expect(location?.exact).to.equal(false);
    expect(text(current, location)).to.equal(edited);
  });

  it('follows text whose surroundings changed on one side', () => {
    const current = REVIEWED.replace(
      'Last quarter we evaluated three tools for the new team wiki.',
      'We tried several tools.',
    ).replace(QUOTE, 'The results was mixed, and many pages had not been touched since 2021.');
    const location = locateReviewExcerpt(current, REVIEWED, QUOTE);
    expect(location?.exact).to.equal(false);
    expect(text(current, location)).to.equal(
      'The results was mixed, and many pages had not been touched since 2021.',
    );
  });

  it('marks where deleted text was with an empty range', () => {
    const current = REVIEWED.replace(`${QUOTE}\n\n`, '');
    const location = locateReviewExcerpt(current, REVIEWED, QUOTE);
    expect(location?.exact).to.equal(false);
    expect(location?.start).to.equal(location?.end);
    expect(current.slice(location?.start)).to.match(/^DocBlocks stood out/u);
  });

  it('falls back to the most similar line when nothing around it is left', () => {
    const current = [
      '# Rewritten',
      'Something else entirely.',
      '- The results were mixed, and alot of pages had not been touched in years.',
    ].join('\n\n');
    const location = locateReviewExcerpt(current, REVIEWED, QUOTE);
    expect(location?.exact).to.equal(false);
    expect(text(current, location)).to.equal(
      '- The results were mixed, and alot of pages had not been touched in years.',
    );
    // A quote the reviewed document never held still finds its line.
    expect(text(current, locateReviewExcerpt(current, null, QUOTE))).to.equal(
      text(current, location),
    );
  });

  it('gives up rather than guess when nothing is alike', () => {
    expect(locateReviewExcerpt('# Other\n\nA different document now.', REVIEWED, QUOTE)).to.equal(
      null,
    );
    expect(locateReviewExcerpt(REVIEWED, REVIEWED, '')).to.equal(null);
  });
});
