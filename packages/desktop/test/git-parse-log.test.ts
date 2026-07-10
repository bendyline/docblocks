/**
 * Tests for parse-log — the git log --format parser used by the desktop
 * git commands layer.
 */

import { expect } from 'chai';
import { LOG_FORMAT, parseLog } from '../main/git/parse-log.js';

const NUL = '\0';

function record(fields: string[]): string {
  return fields.join(NUL);
}

describe('parse-log', () => {
  it('exports the expected LOG_FORMAT', () => {
    expect(LOG_FORMAT).to.equal('%H%x00%P%x00%an%x00%ae%x00%aI%x00%D%x00%s');
  });

  it('parses multiple commits', () => {
    const stdout =
      record([
        'aaa111',
        'bbb222',
        'Alice',
        'alice@example.com',
        '2026-07-01T10:00:00+00:00',
        '',
        'feat: add thing',
      ]) +
      '\n' +
      record([
        'bbb222',
        'ccc333',
        'Bob',
        'bob@example.com',
        '2026-06-30T09:30:00+00:00',
        '',
        'fix: repair thing',
      ]) +
      '\n';

    const entries = parseLog(stdout);
    expect(entries).to.have.length(2);
    expect(entries[0]).to.deep.equal({
      sha: 'aaa111',
      parents: ['bbb222'],
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      authorDate: '2026-07-01T10:00:00+00:00',
      subject: 'feat: add thing',
      refs: [],
    });
    expect(entries[1].sha).to.equal('bbb222');
    expect(entries[1].authorName).to.equal('Bob');
  });

  it('parses a merge commit with two parents', () => {
    const stdout = record([
      'merge1',
      'p1 p2',
      'Alice',
      'alice@example.com',
      '2026-07-02T11:00:00+00:00',
      '',
      "Merge branch 'feature'",
    ]);
    const [entry] = parseLog(stdout);
    expect(entry.parents).to.deep.equal(['p1', 'p2']);
    expect(entry.subject).to.equal("Merge branch 'feature'");
  });

  it('parses a root commit with no parents', () => {
    const stdout = record([
      'root1',
      '',
      'Alice',
      'alice@example.com',
      '2026-01-01T00:00:00+00:00',
      '',
      'initial commit',
    ]);
    const [entry] = parseLog(stdout);
    expect(entry.parents).to.deep.equal([]);
  });

  it('splits decorations including HEAD -> main and tags', () => {
    const stdout = record([
      'dec1',
      'p1',
      'Alice',
      'alice@example.com',
      '2026-07-03T12:00:00+00:00',
      'HEAD -> main, origin/main, tag: v1.0',
      'chore: release',
    ]);
    const [entry] = parseLog(stdout);
    expect(entry.refs).to.deep.equal(['HEAD -> main', 'origin/main', 'tag: v1.0']);
  });

  it('returns [] for empty input', () => {
    expect(parseLog('')).to.deep.equal([]);
    expect(parseLog('\n')).to.deep.equal([]);
  });

  it('is robust to a trailing newline and blank lines', () => {
    const stdout =
      '\n' +
      record([
        'aaa111',
        '',
        'Alice',
        'alice@example.com',
        '2026-07-01T10:00:00+00:00',
        '',
        'only commit',
      ]) +
      '\n\n';
    const entries = parseLog(stdout);
    expect(entries).to.have.length(1);
    expect(entries[0].subject).to.equal('only commit');
  });
});
