/**
 * Tests for commit-selection — the pure selection state behind the commit
 * dialog: default all-on inclusion, locked (force-included) conflicted
 * files during a merge, toggling, bulk select, and the commit gate.
 */
import { expect } from 'chai';
import type { GitFileChange } from '@bendyline/docblocks/host';
import {
  canCommit,
  initSelection,
  isMergeCommit,
  selectedPaths,
  setAllSelected,
  toggleSelection,
} from '../src/Git/commit-selection.js';

function change(path: string, conflicted = false): GitFileChange {
  return { path, worktree: 'modified', conflicted };
}

describe('commit-selection', () => {
  describe('initSelection', () => {
    it('includes every change by default', () => {
      const selection = initSelection([change('/a.md'), change('/docs/b.md')], false);
      expect(selectedPaths(selection)).to.deep.equal(['/a.md', '/docs/b.md']);
    });

    it('normalises paths to a leading slash', () => {
      const selection = initSelection([change('a.md')], false);
      expect(selectedPaths(selection)).to.deep.equal(['/a.md']);
    });

    it('locks conflicted files when merging', () => {
      const selection = initSelection([change('/a.md'), change('/b.md', true)], true);
      expect(selection.locked.has('/b.md')).to.equal(true);
      expect(selection.locked.has('/a.md')).to.equal(false);
    });

    it('does not lock conflicted files outside a merge', () => {
      const selection = initSelection([change('/b.md', true)], false);
      expect(selection.locked.size).to.equal(0);
    });
  });

  describe('toggleSelection', () => {
    it('flips a path off and back on', () => {
      let selection = initSelection([change('/a.md'), change('/b.md')], false);
      selection = toggleSelection(selection, '/a.md');
      expect(selectedPaths(selection)).to.deep.equal(['/b.md']);
      selection = toggleSelection(selection, '/a.md');
      expect(selectedPaths(selection)).to.deep.equal(['/a.md', '/b.md']);
    });

    it('is a no-op on locked paths', () => {
      const selection = initSelection([change('/b.md', true)], true);
      const after = toggleSelection(selection, '/b.md');
      expect(after).to.equal(selection);
      expect(selectedPaths(after)).to.deep.equal(['/b.md']);
    });
  });

  describe('setAllSelected', () => {
    it('deselects everything except locked paths', () => {
      const selection = initSelection([change('/a.md'), change('/b.md', true)], true);
      const after = setAllSelected(selection, false);
      expect(selectedPaths(after)).to.deep.equal(['/b.md']);
    });

    it('selects everything back on', () => {
      let selection = initSelection([change('/a.md'), change('/b.md')], false);
      selection = setAllSelected(selection, false);
      expect(selectedPaths(selection)).to.deep.equal([]);
      selection = setAllSelected(selection, true);
      expect(selectedPaths(selection)).to.deep.equal(['/a.md', '/b.md']);
    });
  });

  describe('canCommit', () => {
    it('requires a non-blank message', () => {
      const selection = initSelection([change('/a.md')], false);
      expect(canCommit('', selection)).to.equal(false);
      expect(canCommit('   \n', selection)).to.equal(false);
      expect(canCommit('fix: thing', selection)).to.equal(true);
    });

    it('requires at least one selected file', () => {
      const selection = setAllSelected(initSelection([change('/a.md')], false), false);
      expect(canCommit('fix: thing', selection)).to.equal(false);
    });

    it('rejects an empty change list even with a message', () => {
      expect(canCommit('fix: thing', initSelection([], false))).to.equal(false);
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
