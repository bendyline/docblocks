/**
 * Tests for parseStatusPorcelainV2 — the pure parser for
 * `git status --porcelain=v2 --branch --untracked-files=all -z` output.
 */

import { expect } from 'chai';
import { parseStatusPorcelainV2 } from '../main/git/parse-status.js';

const NUL = '\u0000';
const SHA = '3c1e0a1b2c3d4e5f60718293a4b5c6d7e8f90123';
const H0 = '0'.repeat(40);
const H1 = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const H2 = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';
const H3 = '5716ca5987cbf97d6bb54920bea6adde242d87e6';

/** Join records with NUL terminators (every record ends with NUL, as `-z` emits). */
function z(...records: string[]): string {
  return records.map((r) => r + NUL).join('');
}

const HEADERS = [
  `# branch.oid ${SHA}`,
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +0 -0',
];

describe('parseStatusPorcelainV2', () => {
  it('returns defaults for empty input', () => {
    const s = parseStatusPorcelainV2('');
    expect(s).to.deep.equal({
      branch: null,
      detached: false,
      unborn: false,
      head: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      entries: [],
      truncated: false,
    });
  });

  it('parses a clean repo (headers only)', () => {
    const s = parseStatusPorcelainV2(z(...HEADERS));
    expect(s.branch).to.equal('main');
    expect(s.detached).to.equal(false);
    expect(s.unborn).to.equal(false);
    expect(s.head).to.equal(SHA);
    expect(s.upstream).to.equal('origin/main');
    expect(s.ahead).to.equal(0);
    expect(s.behind).to.equal(0);
    expect(s.entries).to.deep.equal([]);
    expect(s.truncated).to.equal(false);
  });

  it('parses a staged-only entry (index side set, worktree absent)', () => {
    const s = parseStatusPorcelainV2(
      z(...HEADERS, `1 A. N... 000000 100644 100644 ${H0} ${H1} docs/new.md`),
    );
    expect(s.entries).to.have.length(1);
    expect(s.entries[0]).to.deep.equal({
      path: 'docs/new.md',
      index: 'added',
      conflicted: false,
    });
    expect(s.entries[0].worktree).to.equal(undefined);
  });

  it('parses an unstaged-only entry (worktree side set, index absent)', () => {
    const s = parseStatusPorcelainV2(
      z(...HEADERS, `1 .M N... 100644 100644 100644 ${H1} ${H1} notes.md`),
    );
    expect(s.entries).to.have.length(1);
    expect(s.entries[0]).to.deep.equal({
      path: 'notes.md',
      worktree: 'modified',
      conflicted: false,
    });
    expect(s.entries[0].index).to.equal(undefined);
  });

  it('parses a both-sides entry and other XY letters', () => {
    const s = parseStatusPorcelainV2(
      z(
        ...HEADERS,
        `1 MM N... 100644 100644 100644 ${H1} ${H2} both.md`,
        `1 D. N... 100644 000000 000000 ${H1} ${H0} gone.md`,
        `1 .T N... 100644 100644 120000 ${H1} ${H1} link.md`,
      ),
    );
    expect(s.entries).to.have.length(3);
    expect(s.entries[0]).to.include({ path: 'both.md', index: 'modified', worktree: 'modified' });
    expect(s.entries[1]).to.include({ path: 'gone.md', index: 'deleted' });
    expect(s.entries[2]).to.include({ path: 'link.md', worktree: 'type-changed' });
  });

  it('parses a rename with two NUL fields (path=new, origPath=old)', () => {
    const s = parseStatusPorcelainV2(
      z(
        ...HEADERS,
        `2 R. N... 100644 100644 100644 ${H1} ${H1} R100 renamed new.md`,
        'original old.md',
      ),
    );
    expect(s.entries).to.have.length(1);
    expect(s.entries[0]).to.deep.equal({
      path: 'renamed new.md',
      origPath: 'original old.md',
      index: 'renamed',
      conflicted: false,
    });
  });

  it('parses a copy entry', () => {
    const s = parseStatusPorcelainV2(
      z(...HEADERS, `2 C. N... 100644 100644 100644 ${H1} ${H1} C075 copy.md`, 'source.md'),
    );
    expect(s.entries[0]).to.deep.equal({
      path: 'copy.md',
      origPath: 'source.md',
      index: 'copied',
      conflicted: false,
    });
  });

  it('parses untracked entries', () => {
    const s = parseStatusPorcelainV2(z(...HEADERS, '? assets/img.png'));
    expect(s.entries[0]).to.deep.equal({
      path: 'assets/img.png',
      worktree: 'untracked',
      conflicted: false,
    });
  });

  it('parses ignored entries', () => {
    const s = parseStatusPorcelainV2(z(...HEADERS, '! dist/output.js'));
    expect(s.entries[0]).to.deep.equal({
      path: 'dist/output.js',
      worktree: 'ignored',
      conflicted: false,
    });
  });

  it('parses an unmerged (both-modified) u-entry as conflicted', () => {
    const s = parseStatusPorcelainV2(
      z(...HEADERS, `u UU N... 100644 100644 100644 100644 ${H1} ${H2} ${H3} conflicted.md`),
    );
    expect(s.entries).to.have.length(1);
    expect(s.entries[0]).to.deep.equal({
      path: 'conflicted.md',
      index: 'unmerged',
      worktree: 'unmerged',
      conflicted: true,
    });
  });

  it('parses detached HEAD', () => {
    const s = parseStatusPorcelainV2(z(`# branch.oid ${SHA}`, '# branch.head (detached)'));
    expect(s.detached).to.equal(true);
    expect(s.branch).to.equal(null);
    expect(s.head).to.equal(SHA);
  });

  it('parses an unborn branch', () => {
    const s = parseStatusPorcelainV2(z('# branch.oid (initial)', '# branch.head main'));
    expect(s.unborn).to.equal(true);
    expect(s.head).to.equal(null);
    expect(s.branch).to.equal('main');
  });

  it('parses ahead/behind counts', () => {
    const s = parseStatusPorcelainV2(
      z(
        `# branch.oid ${SHA}`,
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +3 -2',
      ),
    );
    expect(s.ahead).to.equal(3);
    expect(s.behind).to.equal(2);
  });

  it('leaves upstream null and ahead/behind 0 when there is no upstream', () => {
    const s = parseStatusPorcelainV2(z(`# branch.oid ${SHA}`, '# branch.head feature/x'));
    expect(s.branch).to.equal('feature/x');
    expect(s.upstream).to.equal(null);
    expect(s.ahead).to.equal(0);
    expect(s.behind).to.equal(0);
  });

  it('caps entries at maxEntries and sets truncated', () => {
    const records = Array.from({ length: 10 }, (_, i) => `? file-${i}.md`);
    const s = parseStatusPorcelainV2(z(...HEADERS, ...records), 5);
    expect(s.entries).to.have.length(5);
    expect(s.entries.map((e) => e.path)).to.deep.equal([
      'file-0.md',
      'file-1.md',
      'file-2.md',
      'file-3.md',
      'file-4.md',
    ]);
    expect(s.truncated).to.equal(true);
  });

  it('keeps records aligned when a rename record is dropped by the cap', () => {
    const s = parseStatusPorcelainV2(
      z('? a.md', `2 R. N... 100644 100644 100644 ${H1} ${H1} R100 new.md`, 'old.md', '? b.md'),
      1,
    );
    expect(s.entries).to.have.length(1);
    expect(s.entries[0].path).to.equal('a.md');
    expect(s.truncated).to.equal(true);
  });

  it('handles paths containing spaces and non-ASCII characters', () => {
    const s = parseStatusPorcelainV2(
      z(
        ...HEADERS,
        `1 .M N... 100644 100644 100644 ${H1} ${H1} My Document draft.md`,
        '? notes/日本語 ファイル.md',
      ),
    );
    expect(s.entries[0].path).to.equal('My Document draft.md');
    expect(s.entries[1].path).to.equal('notes/日本語 ファイル.md');
  });

  it('skips unknown record types and tolerates missing trailing NUL', () => {
    const input = z(...HEADERS, 'z mystery record', '? tracked-later.md').slice(0, -1);
    const s = parseStatusPorcelainV2(input);
    expect(s.branch).to.equal('main');
    expect(s.entries).to.have.length(1);
    expect(s.entries[0].path).to.equal('tracked-later.md');
  });

  it('skips malformed entry records without throwing', () => {
    const s = parseStatusPorcelainV2(z(...HEADERS, '1 MM', 'u UU N...', '? ok.md'));
    expect(s.entries).to.have.length(1);
    expect(s.entries[0].path).to.equal('ok.md');
  });
});
