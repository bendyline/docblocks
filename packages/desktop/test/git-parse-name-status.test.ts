/**
 * Tests for parse-name-status — the NUL-terminated `git diff-tree
 * --name-status -z` parser used by the desktop git commands layer.
 */

import { expect } from 'chai';
import { parseNameStatusZ } from '../main/git/parse-name-status.js';

const NUL = '\0';

describe('parse-name-status', () => {
  it('parses A / M / D records', () => {
    const stdout = ['A', 'docs/new.md', 'M', 'README.md', 'D', 'old/gone.md'].join(NUL) + NUL;
    expect(parseNameStatusZ(stdout)).to.deep.equal([
      { path: 'docs/new.md', status: 'added' },
      { path: 'README.md', status: 'modified' },
      { path: 'old/gone.md', status: 'deleted' },
    ]);
  });

  it('parses R100 with old-then-new path ordering (path = new, origPath = old)', () => {
    const stdout = ['R100', 'src/before.ts', 'src/after.ts'].join(NUL) + NUL;
    expect(parseNameStatusZ(stdout)).to.deep.equal([
      { path: 'src/after.ts', origPath: 'src/before.ts', status: 'renamed' },
    ]);
  });

  it('parses C75 copies with two path fields', () => {
    const stdout = ['C75', 'templates/base.md', 'docs/derived.md'].join(NUL) + NUL;
    expect(parseNameStatusZ(stdout)).to.deep.equal([
      { path: 'docs/derived.md', origPath: 'templates/base.md', status: 'copied' },
    ]);
  });

  it('parses T as type-changed', () => {
    const stdout = ['T', 'bin/link'].join(NUL) + NUL;
    expect(parseNameStatusZ(stdout)).to.deep.equal([{ path: 'bin/link', status: 'type-changed' }]);
  });

  it('parses U as unmerged', () => {
    const stdout = ['U', 'conflicted.md'].join(NUL) + NUL;
    expect(parseNameStatusZ(stdout)).to.deep.equal([{ path: 'conflicted.md', status: 'unmerged' }]);
  });

  it('is robust to the trailing NUL (and its absence)', () => {
    const withTrailing = ['M', 'a.md'].join(NUL) + NUL;
    const withoutTrailing = ['M', 'a.md'].join(NUL);
    expect(parseNameStatusZ(withTrailing)).to.deep.equal([{ path: 'a.md', status: 'modified' }]);
    expect(parseNameStatusZ(withoutTrailing)).to.deep.equal([{ path: 'a.md', status: 'modified' }]);
  });

  it('returns [] for empty input', () => {
    expect(parseNameStatusZ('')).to.deep.equal([]);
    expect(parseNameStatusZ(NUL)).to.deep.equal([]);
  });

  it('skips records with unknown status letters, consuming the right field count', () => {
    // 'X' is unknown and single-path; the following M record must survive.
    const stdout = ['X', 'weird.md', 'M', 'kept.md'].join(NUL) + NUL;
    expect(parseNameStatusZ(stdout)).to.deep.equal([{ path: 'kept.md', status: 'modified' }]);
  });

  it('mixes one-path and two-path records in sequence', () => {
    const stdout =
      ['A', 'new.md', 'R090', 'old-name.md', 'new-name.md', 'D', 'dropped.md'].join(NUL) + NUL;
    expect(parseNameStatusZ(stdout)).to.deep.equal([
      { path: 'new.md', status: 'added' },
      { path: 'new-name.md', origPath: 'old-name.md', status: 'renamed' },
      { path: 'dropped.md', status: 'deleted' },
    ]);
  });
});
