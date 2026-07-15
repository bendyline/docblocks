/**
 * Tests for commit-selection — the pure selection state behind the commit
 * dialog: default all-on inclusion, locked (force-included) conflicted
 * files during a merge, toggling, bulk select, and the commit gate.
 *
 * The selection is resolved from the live change list on every call rather
 * than snapshotted, so files that git reports after the dialog opened are
 * covered too.
 */
import { expect } from 'chai';
import type { GitFileChange } from '@bendyline/docblocks/host';
import {
  allSelected,
  canCommit,
  isIncluded,
  isLocked,
  isMergeCommit,
  NO_OVERRIDES,
  resolveSelection,
  selectedPaths,
  setAllOverrides,
  toggleOverride,
  type CommitOverrides,
} from '../src/Git/commit-selection.js';

function change(path: string, conflicted = false): GitFileChange {
  return { path, worktree: 'modified', conflicted };
}

describe('commit-selection', () => {
  describe('resolveSelection', () => {
    it('includes every change by default', () => {
      const selection = resolveSelection([change('/a.md'), change('/docs/b.md')], false);
      expect(selectedPaths(selection)).to.deep.equal(['/a.md', '/docs/b.md']);
    });

    it('normalises paths to a leading slash', () => {
      const selection = resolveSelection([change('a.md')], false);
      expect(selectedPaths(selection)).to.deep.equal(['/a.md']);
    });

    it('locks conflicted files when merging', () => {
      const selection = resolveSelection([change('/a.md'), change('/b.md', true)], true);
      expect(isLocked(selection, '/b.md')).to.equal(true);
      expect(isLocked(selection, '/a.md')).to.equal(false);
    });

    it('does not lock conflicted files outside a merge', () => {
      const selection = resolveSelection([change('/b.md')], false);
      expect(selection.locked.size).to.equal(0);
    });

    it('force-includes a locked file even against an exclude override', () => {
      const overrides: CommitOverrides = new Map([['/b.md', false]]);
      const selection = resolveSelection([change('/b.md', true)], true, overrides);
      expect(selectedPaths(selection)).to.deep.equal(['/b.md']);
    });

    it('covers exactly the live change list, not the overrides', () => {
      // A file the user excluded earlier that git no longer reports must
      // not leak into the commit.
      const overrides: CommitOverrides = new Map([['/gone.md', true]]);
      const selection = resolveSelection([change('/a.md')], false, overrides);
      expect([...selection.included.keys()]).to.deep.equal(['/a.md']);
      expect(selectedPaths(selection)).to.deep.equal(['/a.md']);
    });

    it('resolves paths appearing after the dialog opened as included', () => {
      // Autosave pushes a status refresh every 1.5s; a file first seen then
      // renders checked and must therefore commit.
      const overrides = toggleOverride(
        NO_OVERRIDES,
        resolveSelection([change('/a.md')], false),
        '/a.md',
      );
      const withLateFile = resolveSelection(
        [change('/a.md'), change('/late.md')],
        false,
        overrides,
      );
      expect(isIncluded(withLateFile, '/late.md')).to.equal(true);
      expect(selectedPaths(withLateFile)).to.deep.equal(['/late.md']);
    });
  });

  describe('toggleOverride', () => {
    it('excludes a default-included path in a single toggle', () => {
      // Regression: reading a missing key as `false` made the first toggle
      // of a never-touched file *include* it, so two were needed to
      // exclude what the checkbox already showed as checked.
      const selection = resolveSelection([change('/a.md'), change('/b.md')], false);
      const overrides = toggleOverride(NO_OVERRIDES, selection, '/a.md');
      expect(
        selectedPaths(resolveSelection([change('/a.md'), change('/b.md')], false, overrides)),
      ).to.deep.equal(['/b.md']);
    });

    it('excludes a path that appeared after mount in a single toggle', () => {
      const initial = resolveSelection([change('/a.md')], false);
      const live = [change('/a.md'), change('/late.md')];
      const selection = resolveSelection(live, false, NO_OVERRIDES);
      expect(initial.included.has('/late.md')).to.equal(false);

      const overrides = toggleOverride(NO_OVERRIDES, selection, '/late.md');
      expect(selectedPaths(resolveSelection(live, false, overrides))).to.deep.equal(['/a.md']);
    });

    it('flips a path off and back on', () => {
      const changes = [change('/a.md'), change('/b.md')];
      let overrides = toggleOverride(NO_OVERRIDES, resolveSelection(changes, false), '/a.md');
      expect(selectedPaths(resolveSelection(changes, false, overrides))).to.deep.equal(['/b.md']);

      overrides = toggleOverride(overrides, resolveSelection(changes, false, overrides), '/a.md');
      expect(selectedPaths(resolveSelection(changes, false, overrides))).to.deep.equal([
        '/a.md',
        '/b.md',
      ]);
    });

    it('normalises the toggled path', () => {
      const changes = [change('a.md')];
      const overrides = toggleOverride(NO_OVERRIDES, resolveSelection(changes, false), 'a.md');
      expect(selectedPaths(resolveSelection(changes, false, overrides))).to.deep.equal([]);
    });

    it('is a no-op on locked paths', () => {
      const selection = resolveSelection([change('/b.md', true)], true);
      const after = toggleOverride(NO_OVERRIDES, selection, '/b.md');
      expect(after).to.equal(NO_OVERRIDES);
    });
  });

  describe('setAllOverrides', () => {
    it('deselects everything except locked paths', () => {
      const changes = [change('/a.md'), change('/b.md', true)];
      const overrides = setAllOverrides(resolveSelection(changes, true), false);
      expect(selectedPaths(resolveSelection(changes, true, overrides))).to.deep.equal(['/b.md']);
    });

    it('selects everything back on', () => {
      const changes = [change('/a.md'), change('/b.md')];
      let overrides = setAllOverrides(resolveSelection(changes, false), false);
      expect(selectedPaths(resolveSelection(changes, false, overrides))).to.deep.equal([]);

      overrides = setAllOverrides(resolveSelection(changes, false, overrides), true);
      expect(selectedPaths(resolveSelection(changes, false, overrides))).to.deep.equal([
        '/a.md',
        '/b.md',
      ]);
    });

    it('leaves a later-appearing file included after a select-none', () => {
      // "Select none" can only speak for what git had reported at the time;
      // a file arriving afterwards renders checked, so it must commit.
      const overrides = setAllOverrides(resolveSelection([change('/a.md')], false), false);
      const live = resolveSelection([change('/a.md'), change('/late.md')], false, overrides);
      expect(selectedPaths(live)).to.deep.equal(['/late.md']);
    });
  });

  describe('allSelected', () => {
    it('tracks whether every live change is included', () => {
      const changes = [change('/a.md'), change('/b.md')];
      expect(allSelected(resolveSelection(changes, false))).to.equal(true);
      const overrides = toggleOverride(NO_OVERRIDES, resolveSelection(changes, false), '/a.md');
      expect(allSelected(resolveSelection(changes, false, overrides))).to.equal(false);
    });
  });

  describe('canCommit', () => {
    it('requires a non-blank message', () => {
      const selection = resolveSelection([change('/a.md')], false);
      expect(canCommit('', selection)).to.equal(false);
      expect(canCommit('   \n', selection)).to.equal(false);
      expect(canCommit('fix: thing', selection)).to.equal(true);
    });

    it('requires at least one selected file', () => {
      const changes = [change('/a.md')];
      const overrides = setAllOverrides(resolveSelection(changes, false), false);
      expect(canCommit('fix: thing', resolveSelection(changes, false, overrides))).to.equal(false);
    });

    it('rejects an empty change list even with a message', () => {
      expect(canCommit('fix: thing', resolveSelection([], false))).to.equal(false);
    });
  });

  describe('isMergeCommit', () => {
    it('is true only for a merge operation', () => {
      expect(isMergeCommit(null)).to.equal(false);
      const base = {
        branch: 'main',
        detached: false,
        unborn: false,
        head: 'abc',
        upstream: null,
        ahead: 0,
        behind: 0,
        changes: [],
        truncated: false,
      };
      expect(isMergeCommit({ ...base, operation: 'merge' })).to.equal(true);
      expect(isMergeCommit({ ...base, operation: 'rebase' })).to.equal(false);
      expect(isMergeCommit({ ...base, operation: null })).to.equal(false);
    });
  });
});
