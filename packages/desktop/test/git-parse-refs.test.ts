/**
 * Tests for parse-refs — the git for-each-ref parser used by the desktop
 * git commands layer.
 */

import { expect } from 'chai';
import { FOR_EACH_REF_FORMAT, parseForEachRef } from '../main/git/parse-refs.js';

const NUL = '\0';

interface RefFields {
  head?: string;
  short: string;
  full: string;
  sha?: string;
  upstream?: string;
  track?: string;
  date?: string;
  subject?: string;
}

function record(f: RefFields): string {
  return [
    f.head ?? ' ',
    f.short,
    f.full,
    f.sha ?? 'deadbeef',
    f.upstream ?? '',
    f.track ?? '',
    f.date ?? '2026-07-01T10:00:00+00:00',
    f.subject ?? 'a subject',
  ].join(NUL);
}

describe('parse-refs', () => {
  it('exports the expected FOR_EACH_REF_FORMAT', () => {
    expect(FOR_EACH_REF_FORMAT).to.equal(
      '%(HEAD)%00%(refname:short)%00%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:iso8601-strict)%00%(contents:subject)',
    );
  });

  it('marks the current branch from the star field', () => {
    const stdout =
      record({ head: '*', short: 'main', full: 'refs/heads/main' }) +
      '\n' +
      record({ head: ' ', short: 'other', full: 'refs/heads/other' });
    const branches = parseForEachRef(stdout);
    expect(branches).to.have.length(2);
    expect(branches[0].current).to.equal(true);
    expect(branches[1].current).to.equal(false);
    expect(branches[0].name).to.equal('main');
    expect(branches[0].kind).to.equal('local');
  });

  it('parses ahead/behind/gone track variants', () => {
    const stdout = [
      record({ short: 'a', full: 'refs/heads/a', upstream: 'origin/a', track: '' }),
      record({ short: 'b', full: 'refs/heads/b', upstream: 'origin/b', track: '[ahead 1]' }),
      record({ short: 'c', full: 'refs/heads/c', upstream: 'origin/c', track: '[behind 2]' }),
      record({
        short: 'd',
        full: 'refs/heads/d',
        upstream: 'origin/d',
        track: '[ahead 1, behind 2]',
      }),
      record({ short: 'e', full: 'refs/heads/e', upstream: 'origin/e', track: '[gone]' }),
    ].join('\n');
    const [a, b, c, d, e] = parseForEachRef(stdout);
    expect(a).to.include({ ahead: 0, behind: 0, upstreamGone: false, upstream: 'origin/a' });
    expect(b).to.include({ ahead: 1, behind: 0, upstreamGone: false });
    expect(c).to.include({ ahead: 0, behind: 2, upstreamGone: false });
    expect(d).to.include({ ahead: 1, behind: 2, upstreamGone: false });
    expect(e).to.include({ ahead: 0, behind: 0, upstreamGone: true });
  });

  it('maps empty upstream to null', () => {
    const [branch] = parseForEachRef(
      record({ short: 'local-only', full: 'refs/heads/local-only', upstream: '' }),
    );
    expect(branch.upstream).to.equal(null);
  });

  it('classifies remote refs and carries head metadata', () => {
    const [branch] = parseForEachRef(
      record({
        short: 'origin/main',
        full: 'refs/remotes/origin/main',
        sha: 'cafe1234',
        date: '2026-06-15T08:00:00+00:00',
        subject: 'remote tip subject',
      }),
    );
    expect(branch.kind).to.equal('remote');
    expect(branch.name).to.equal('origin/main');
    expect(branch.headSha).to.equal('cafe1234');
    expect(branch.headDate).to.equal('2026-06-15T08:00:00+00:00');
    expect(branch.headSubject).to.equal('remote tip subject');
  });

  it('skips symbolic origin/HEAD entries', () => {
    const stdout =
      record({ short: 'origin/HEAD', full: 'refs/remotes/origin/HEAD' }) +
      '\n' +
      record({ short: 'origin/main', full: 'refs/remotes/origin/main' });
    const branches = parseForEachRef(stdout);
    expect(branches).to.have.length(1);
    expect(branches[0].name).to.equal('origin/main');
  });

  it('preserves subjects containing commas', () => {
    const [branch] = parseForEachRef(
      record({
        short: 'main',
        full: 'refs/heads/main',
        subject: 'fix: handle a, b, and c properly',
      }),
    );
    expect(branch.headSubject).to.equal('fix: handle a, b, and c properly');
  });

  it('returns [] for empty input', () => {
    expect(parseForEachRef('')).to.deep.equal([]);
    expect(parseForEachRef('\n')).to.deep.equal([]);
  });
});
