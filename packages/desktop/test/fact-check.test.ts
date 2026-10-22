import { expect } from 'chai';
import { checkFacts } from '../main/ai/fact-check.js';

const passage =
  'The Panama Hotel in Seattle was built in 1910 by Sabro Ozasa, the first Japanese-American ' +
  'architect in Seattle. It contains the last remaining Japanese bathhouse in the United States.';

describe('fact check of AI output', () => {
  it('reports details no passage or person shows, dates and numbers first', () => {
    const result = checkFacts({
      text:
        'The Panama Hotel was built in 1910 by Sabro Ozasa. ' +
        'It was named for the Panama Steamship Company. ' +
        'A fire damaged it on March 26, 1913. ' +
        'It is a wonderful place to visit.',
      evidence: [passage],
      given: 'Write about the Panama Hotel.',
    });
    expect(result.checked).to.equal(3);
    expect(result.unsourced.map((sentence) => sentence.strong)).to.deep.equal([true, false]);
    expect(result.unsourced[0].text).to.contain('March 26, 1913');
    expect(result.unsourced[0].missing).to.include('1913');
    expect(result.unsourced[1].missing).to.include.members(['Steamship', 'Company']);
  });

  it("counts the person's own words as a source", () => {
    const result = checkFacts({
      text: 'Our office opened in 1987 in Tacoma.',
      evidence: [],
      given: 'Instructions: say the office opened in 1987 in Tacoma.',
    });
    expect(result).to.deep.equal({ checked: 1, unsourced: [] });
  });

  it('ignores citation markers the model was never asked for', () => {
    const result = checkFacts({
      text: 'The hotel was built in 1910 [7].',
      evidence: [passage],
      given: '',
    });
    expect(result.unsourced).to.deep.equal([]);
  });

  it('accepts a plainly stated gap', () => {
    const result = checkFacts({
      text: 'The year the bathhouse closed could not be verified.',
      evidence: [passage],
      given: '',
    });
    expect(result.unsourced).to.deep.equal([]);
  });
});
