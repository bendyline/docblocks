/**
 * Schema-ish sanity check for the FileExplorer badge wiring: a realistic
 * GitStatus with a mix of change kinds must produce a badge map whose
 * keys are all slash-prefixed tree paths and whose values are all valid
 * GitBadgeKind strings (every kind has a glyph and a label).
 */
import { expect } from 'chai';
import type { GitStatus } from '@bendyline/docblocks/host';
import { BADGE_GLYPHS, BADGE_LABELS, buildBadgeMap } from '../src/Git/git-status.js';

const fixture: GitStatus = {
  branch: 'main',
  detached: false,
  unborn: false,
  head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  upstream: 'origin/main',
  ahead: 1,
  behind: 2,
  changes: [
    { path: '/notes/todo.md', worktree: 'modified', conflicted: false },
    { path: 'docs/guide/intro.md', index: 'added', conflicted: false },
    { path: '/docs/guide/old.md', worktree: 'deleted', conflicted: false },
    { path: '/assets/logo.md', worktree: 'untracked', conflicted: false },
    {
      path: '/docs/renamed.md',
      origPath: '/docs/original.md',
      index: 'renamed',
      conflicted: false,
    },
    { path: '/shared/clash.md', index: 'modified', worktree: 'modified', conflicted: true },
    { path: '.gitignore', worktree: 'modified', conflicted: false },
  ],
  truncated: false,
  operation: 'merge',
};

describe('git badge integration (FileExplorer wiring)', () => {
  it('produces slash-prefixed keys and valid GitBadgeKind values only', () => {
    const validKinds = new Set<string>(Object.keys(BADGE_GLYPHS));
    const badges = buildBadgeMap(fixture.changes);

    expect(badges.size).to.be.greaterThan(0);
    for (const [path, kind] of badges) {
      expect(path.startsWith('/'), `key "${path}" must start with '/'`).to.equal(true);
      expect(validKinds.has(kind), `value "${kind}" must be a GitBadgeKind`).to.equal(true);
      // Every kind must render: glyph + accessible label both defined.
      expect(BADGE_GLYPHS[kind]).to.be.a('string').and.not.equal('');
      expect(BADGE_LABELS[kind]).to.be.a('string').and.not.equal('');
    }

    // Spot-check the interesting rows survived the mapping.
    expect(badges.get('/shared/clash.md')).to.equal('conflicted');
    expect(badges.get('/shared')).to.equal('conflicted');
    expect(badges.get('/docs/guide/intro.md')).to.equal('added');
    expect(badges.get('/docs')).to.equal('dir');
    expect(badges.has('/docs/guide/old.md')).to.equal(false);
    expect(badges.has('/.gitignore')).to.equal(false);
  });
});
