/**
 * Tests for the pure git-status helpers: badge precedence, directory
 * rollups (including the conflicted-beats-dir rule and dot-path
 * exclusion), ahead/behind formatting, dirty checks, and summaries.
 */
import { expect } from 'chai';
import type { GitFileChange, GitStatus } from '@bendyline/docblocks/host';
import {
  badgeKindFor,
  buildBadgeMap,
  conflictedPaths,
  formatAheadBehind,
  isFileDirty,
  summarizeDirty,
} from '../src/Git/git-status.js';

function change(path: string, opts: Partial<GitFileChange> = {}): GitFileChange {
  return { path, conflicted: false, ...opts };
}

function makeStatus(changes: GitFileChange[], extra: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'main',
    detached: false,
    unborn: false,
    head: 'abc1234',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    changes,
    truncated: false,
    operation: null,
    ...extra,
  };
}

describe('git-status helpers', () => {
  describe('badgeKindFor', () => {
    it('conflicted wins over everything else', () => {
      expect(badgeKindFor(change('/a.md', { conflicted: true, worktree: 'untracked' }))).to.equal(
        'conflicted',
      );
      expect(badgeKindFor(change('/a.md', { conflicted: true, index: 'deleted' }))).to.equal(
        'conflicted',
      );
    });

    it('untracked wins over deleted/renamed/added/modified', () => {
      expect(badgeKindFor(change('/a.md', { worktree: 'untracked', index: 'deleted' }))).to.equal(
        'untracked',
      );
    });

    it('deleted (index or worktree) wins over renamed', () => {
      expect(badgeKindFor(change('/a.md', { index: 'deleted', worktree: 'renamed' }))).to.equal(
        'deleted',
      );
      expect(badgeKindFor(change('/a.md', { worktree: 'deleted' }))).to.equal('deleted');
    });

    it('renamed wins over added', () => {
      expect(badgeKindFor(change('/a.md', { index: 'renamed', worktree: 'added' }))).to.equal(
        'renamed',
      );
      expect(badgeKindFor(change('/a.md', { worktree: 'renamed' }))).to.equal('renamed');
    });

    it('added wins over modified', () => {
      expect(badgeKindFor(change('/a.md', { index: 'added', worktree: 'modified' }))).to.equal(
        'added',
      );
      expect(badgeKindFor(change('/a.md', { worktree: 'added' }))).to.equal('added');
    });

    it('falls back to modified', () => {
      expect(badgeKindFor(change('/a.md', { worktree: 'modified' }))).to.equal('modified');
      expect(badgeKindFor(change('/a.md', { index: 'modified' }))).to.equal('modified');
      expect(badgeKindFor(change('/a.md'))).to.equal('modified');
    });
  });

  describe('buildBadgeMap', () => {
    it('normalises bare (unslashed) paths to slash-prefixed keys', () => {
      const badges = buildBadgeMap([change('docs/readme.md', { worktree: 'modified' })]);
      expect(badges.get('/docs/readme.md')).to.equal('modified');
      expect(badges.has('docs/readme.md')).to.equal(false);
    });

    it('gives changed files a badge of their own kind', () => {
      const badges = buildBadgeMap([
        change('/a.md', { worktree: 'modified' }),
        change('/b.md', { worktree: 'untracked' }),
      ]);
      expect(badges.get('/a.md')).to.equal('modified');
      expect(badges.get('/b.md')).to.equal('untracked');
    });

    it('deleted files get no file badge but still dot their ancestors', () => {
      const badges = buildBadgeMap([change('/docs/gone.md', { index: 'deleted' })]);
      expect(badges.has('/docs/gone.md')).to.equal(false);
      expect(badges.get('/docs')).to.equal('dir');
    });

    it('rolls up every ancestor directory of a nested change', () => {
      const badges = buildBadgeMap([change('/docs/a/b.md', { worktree: 'modified' })]);
      expect(badges.get('/docs')).to.equal('dir');
      expect(badges.get('/docs/a')).to.equal('dir');
      expect(badges.get('/docs/a/b.md')).to.equal('modified');
      expect(badges.size).to.equal(3);
    });

    it('a conflicted descendant wins the rollup regardless of change order', () => {
      const conflicted = change('/docs/a/x.md', { conflicted: true });
      const modified = change('/docs/b/y.md', { worktree: 'modified' });
      for (const changes of [
        [modified, conflicted],
        [conflicted, modified],
      ]) {
        const badges = buildBadgeMap(changes);
        expect(badges.get('/docs')).to.equal('conflicted');
        expect(badges.get('/docs/a')).to.equal('conflicted');
        expect(badges.get('/docs/b')).to.equal('dir');
      }
    });

    it('excludes dot-paths entirely (.gitignore, .github/x.md)', () => {
      const badges = buildBadgeMap([
        change('.gitignore', { worktree: 'modified' }),
        change('.github/x.md', { worktree: 'untracked' }),
      ]);
      expect(badges.size).to.equal(0);
    });

    it('a directory that is itself a changed file keeps its file badge over the rollup', () => {
      const badges = buildBadgeMap([
        change('/docs', { worktree: 'modified' }),
        change('/docs/a.md', { worktree: 'untracked' }),
      ]);
      expect(badges.get('/docs')).to.equal('modified');
      expect(badges.get('/docs/a.md')).to.equal('untracked');
    });
  });

  describe('formatAheadBehind', () => {
    it('returns empty string when neither ahead nor behind', () => {
      expect(formatAheadBehind({ ahead: 0, behind: 0 })).to.equal('');
    });

    it('formats ahead only', () => {
      expect(formatAheadBehind({ ahead: 2, behind: 0 })).to.equal('2↑');
    });

    it('formats behind only', () => {
      expect(formatAheadBehind({ ahead: 0, behind: 3 })).to.equal('3↓');
    });

    it('formats both, ahead first', () => {
      expect(formatAheadBehind({ ahead: 2, behind: 1 })).to.equal('2↑ 1↓');
    });
  });

  describe('isFileDirty', () => {
    const status = makeStatus([change('docs/a.md', { worktree: 'modified' })]);

    it('matches with and without a leading slash on either side', () => {
      expect(isFileDirty(status, '/docs/a.md')).to.equal(true);
      expect(isFileDirty(status, 'docs/a.md')).to.equal(true);
    });

    it('is false for clean files and null inputs', () => {
      expect(isFileDirty(status, '/docs/other.md')).to.equal(false);
      expect(isFileDirty(null, '/docs/a.md')).to.equal(false);
      expect(isFileDirty(status, null)).to.equal(false);
    });
  });

  describe('conflictedPaths', () => {
    it('returns normalised paths of conflicted changes only', () => {
      const status = makeStatus([
        change('docs/clash.md', { conflicted: true }),
        change('/other.md', { worktree: 'modified' }),
        change('/deep/clash2.md', { conflicted: true }),
      ]);
      expect(conflictedPaths(status)).to.deep.equal(['/docs/clash.md', '/deep/clash2.md']);
    });

    it('returns [] for null status', () => {
      expect(conflictedPaths(null)).to.deep.equal([]);
    });
  });

  describe('summarizeDirty', () => {
    it('is empty when clean or null', () => {
      expect(summarizeDirty(makeStatus([]))).to.equal('');
      expect(summarizeDirty(null)).to.equal('');
    });

    it('uses singular for one change', () => {
      expect(summarizeDirty(makeStatus([change('/a.md')]))).to.equal('1 change');
    });

    it('uses plural for several changes', () => {
      expect(
        summarizeDirty(makeStatus([change('/a.md'), change('/b.md'), change('/c.md')])),
      ).to.equal('3 changes');
    });
  });
});
