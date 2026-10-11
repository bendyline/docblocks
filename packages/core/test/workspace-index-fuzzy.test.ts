import { expect } from 'chai';
import { fuzzyMatch, fuzzyMatchTokens, fuzzyTokens } from '../src/workspace-index/fuzzy.js';

describe('quick-open fuzzy matching', () => {
  it('requires every query character in order', () => {
    expect(fuzzyMatch('gzl', 'gezel-release.md')).to.not.equal(null);
    expect(fuzzyMatch('lzg', 'gezel-release.md')).to.equal(null);
    expect(fuzzyMatch('toolong', 'tool')).to.equal(null);
  });

  it('prefers prefixes, word starts, and consecutive runs over scattered hits', () => {
    const prefix = fuzzyMatch('rel', 'release-notes.md')!.score;
    const wordStart = fuzzyMatch('rel', 'gezel-release.md')!.score;
    const scattered = fuzzyMatch('rel', 'reallyverylong.md')!.score;
    expect(prefix).to.be.greaterThan(wordStart);
    expect(wordStart).to.be.greaterThan(scattered);
    expect(fuzzyMatch('nc', 'NativeCheck')!.score).to.be.greaterThan(
      fuzzyMatch('nc', 'nonchalant')!.score,
    );
  });

  it('highlights the tightest window', () => {
    expect(fuzzyMatch('ab', 'a-xab')!.ranges).to.deep.equal([[3, 5]]);
    expect(fuzzyMatch('gc', 'gezel-check')!.ranges).to.deep.equal([
      [0, 1],
      [6, 7],
    ]);
  });

  it('matches every token independently and merges ranges', () => {
    const match = fuzzyMatchTokens(fuzzyTokens('  notes gez '), 'gezel/notes.md');
    expect(match).to.not.equal(null);
    expect(match!.ranges).to.deep.equal([
      [0, 3],
      [6, 11],
    ]);
    expect(fuzzyMatchTokens(['notes', 'zzz'], 'gezel/notes.md')).to.equal(null);
  });
});
