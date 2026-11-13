import { expect } from 'chai';

import { locateReviewExcerpt, quoteOccurrences } from '../src/Ai/review-locate.js';

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

  it('finds a quote of hard-wrapped text whose continuation indent the model dropped', () => {
    const current =
      'Results:\n\n- **Giving the model the goal beats walking it\n  through the steps.** Pooled.\n';
    const location = locateReviewExcerpt(
      current,
      current,
      'Giving the model the goal beats walking it\nthrough the steps.',
    );
    expect(location?.exact).to.equal(true);
    expect(text(current, location)).to.equal(
      'Giving the model the goal beats walking it\n  through the steps.',
    );
  });

  // A match that starts with a character outside the Basic Multilingual Plane
  // used to be found again at the same place without end: Show in document
  // froze the window until the array of copies could grow no further.
  it('finds a re-wrapped quote that starts with an emoji once, and returns', () => {
    const rocket = '\u{1F680}';
    const current = `# Plan\n\n${rocket} Our launch plan are\nready for there review next week.\n`;
    const quote = `${rocket} Our launch plan are ready for there review next week.`;
    const passage = `${rocket} Our launch plan are\nready for there review next week.`;
    const start = current.indexOf(rocket);
    expect(quoteOccurrences(current, quote)).to.deep.equal([
      { start, end: start + passage.length },
    ]);
    const location = locateReviewExcerpt(current, current, quote);
    expect(location?.exact).to.equal(true);
    expect(text(current, location)).to.equal(passage);
  });

  it('counts each copy of an emoji-led quote once, overlapping ones included', () => {
    const rocket = '\u{1F680}';
    const twice = `${rocket} Launch\nplan.\n\nLater: ${rocket} Launch\nplan.`;
    expect(quoteOccurrences(twice, `${rocket} Launch plan.`)).to.have.length(2);
    // "A A" occurs twice in "A\nA\nA", sharing the middle character.
    const overlapping = [rocket, rocket, rocket].join('\n');
    expect(quoteOccurrences(overlapping, `${rocket} ${rocket}`)).to.deep.equal([
      { start: 0, end: 5 },
      { start: 3, end: 8 },
    ]);
  });

  it('follows edited text by what surrounded it when the quote differs in spacing', () => {
    const reviewed = 'Opening line.\n\n- First part of the item\n  second part.\n\nClosing line.';
    const current = reviewed.replace('First part', 'Revised part');
    const location = locateReviewExcerpt(current, reviewed, 'First part of the item\nsecond part.');
    expect(location?.exact).to.equal(false);
    expect(text(current, location)).to.equal('Revised part of the item\n  second part.');
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
