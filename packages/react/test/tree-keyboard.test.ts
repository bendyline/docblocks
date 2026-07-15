/**
 * Tests for tree-keyboard — the pure WAI-ARIA tree-view key contract.
 *
 * Flattening is what makes the rules simple, so the two halves are tested
 * separately: that the flatten matches what the explorer renders, and that
 * each key resolves to the right action given a flattened list.
 */
import { expect } from 'chai';
import type { FileSystemEntry } from '@bendyline/docblocks/filesystem';
import {
  flattenVisibleRows,
  resolveActiveRow,
  treeKeyAction,
  TREE_NAV_KEYS,
  type TreeRow,
  type TreeShape,
} from '../src/FileExplorer/tree-keyboard.js';

function file(path: string): FileSystemEntry {
  return { kind: 'file', name: path.split('/').pop() ?? path, path };
}

function dir(path: string): FileSystemEntry {
  return { kind: 'directory', name: path.split('/').pop() ?? path, path };
}

/** Build a TreeShape from a literal description. */
function shape(
  roots: FileSystemEntry[],
  children: Record<string, FileSystemEntry[]> = {},
  expanded: string[] = [],
  hidden: string[] = [],
): TreeShape {
  return {
    roots,
    childrenOf: (dirPath) => children[dirPath] ?? [],
    isExpanded: (dirPath) => expanded.includes(dirPath),
    isVisible: (entry) => !hidden.includes(entry.path),
  };
}

function row(
  path: string,
  kind: 'file' | 'directory',
  depth: number,
  expanded: boolean,
  parentPath: string | null,
): TreeRow {
  return { path, kind, depth, expanded, parentPath };
}

describe('tree-keyboard', () => {
  describe('flattenVisibleRows', () => {
    it('lists roots in order at depth 0', () => {
      const rows = flattenVisibleRows(shape([file('/a.md'), file('/b.md')]));
      expect(rows.map((r) => r.path)).to.deep.equal(['/a.md', '/b.md']);
      expect(rows.every((r) => r.depth === 0 && r.parentPath === null)).to.equal(true);
    });

    it('omits the children of a collapsed folder', () => {
      const rows = flattenVisibleRows(
        shape([dir('/notes'), file('/z.md')], { '/notes': [file('/notes/a.md')] }, []),
      );
      expect(rows.map((r) => r.path)).to.deep.equal(['/notes', '/z.md']);
    });

    it('splices an expanded folder’s children in directly beneath it', () => {
      const rows = flattenVisibleRows(
        shape(
          [dir('/notes'), file('/z.md')],
          { '/notes': [file('/notes/a.md'), file('/notes/b.md')] },
          ['/notes'],
        ),
      );
      expect(rows.map((r) => r.path)).to.deep.equal([
        '/notes',
        '/notes/a.md',
        '/notes/b.md',
        '/z.md',
      ]);
      expect(rows[1].depth).to.equal(1);
      expect(rows[1].parentPath).to.equal('/notes');
    });

    it('nests arbitrarily deep', () => {
      const rows = flattenVisibleRows(
        shape([dir('/a')], { '/a': [dir('/a/b')], '/a/b': [file('/a/b/c.md')] }, ['/a', '/a/b']),
      );
      expect(rows.map((r) => [r.path, r.depth])).to.deep.equal([
        ['/a', 0],
        ['/a/b', 1],
        ['/a/b/c.md', 2],
      ]);
    });

    it('skips hidden entries so arrow keys match what is rendered', () => {
      const rows = flattenVisibleRows(
        shape([file('/.gitignore'), file('/a.md')], {}, [], ['/.gitignore']),
      );
      expect(rows.map((r) => r.path)).to.deep.equal(['/a.md']);
    });
  });

  describe('resolveActiveRow', () => {
    const rows = [row('/a.md', 'file', 0, false, null), row('/b.md', 'file', 0, false, null)];

    it('keeps the active row when it still exists', () => {
      expect(resolveActiveRow(rows, '/b.md', null)).to.equal('/b.md');
    });

    it('falls back to the selected document when the active row is gone', () => {
      expect(resolveActiveRow(rows, '/deleted.md', '/b.md')).to.equal('/b.md');
    });

    it('falls back to the first row so the tree always has a tab stop', () => {
      expect(resolveActiveRow(rows, null, null)).to.equal('/a.md');
      expect(resolveActiveRow(rows, '/gone.md', '/also-gone.md')).to.equal('/a.md');
    });

    it('is null only when the tree is empty', () => {
      expect(resolveActiveRow([], '/a.md', '/a.md')).to.equal(null);
    });
  });

  describe('treeKeyAction', () => {
    // /notes (expanded) > /notes/a.md ; /empty (expanded, no children) ; /z.md
    const rows = [
      row('/notes', 'directory', 0, true, null),
      row('/notes/a.md', 'file', 1, false, '/notes'),
      row('/empty', 'directory', 0, true, null),
      row('/z.md', 'file', 0, false, null),
    ];

    it('ArrowDown moves to the next visible row', () => {
      expect(treeKeyAction(rows, '/notes', 'ArrowDown')).to.deep.equal({
        type: 'focus',
        path: '/notes/a.md',
      });
    });

    it('ArrowUp moves to the previous visible row', () => {
      expect(treeKeyAction(rows, '/z.md', 'ArrowUp')).to.deep.equal({
        type: 'focus',
        path: '/empty',
      });
    });

    it('stops at the ends rather than wrapping', () => {
      expect(treeKeyAction(rows, '/notes', 'ArrowUp')).to.deep.equal({ type: 'none' });
      expect(treeKeyAction(rows, '/z.md', 'ArrowDown')).to.deep.equal({ type: 'none' });
    });

    it('Home and End jump to the first and last rows', () => {
      expect(treeKeyAction(rows, '/notes/a.md', 'Home')).to.deep.equal({
        type: 'focus',
        path: '/notes',
      });
      expect(treeKeyAction(rows, '/notes', 'End')).to.deep.equal({ type: 'focus', path: '/z.md' });
    });

    it('ArrowRight expands a collapsed folder', () => {
      const collapsed = [row('/notes', 'directory', 0, false, null)];
      expect(treeKeyAction(collapsed, '/notes', 'ArrowRight')).to.deep.equal({
        type: 'expand',
        path: '/notes',
      });
    });

    it('ArrowRight on an expanded folder moves to its first child', () => {
      expect(treeKeyAction(rows, '/notes', 'ArrowRight')).to.deep.equal({
        type: 'focus',
        path: '/notes/a.md',
      });
    });

    it('ArrowRight on an expanded but empty folder does not jump to a sibling', () => {
      expect(treeKeyAction(rows, '/empty', 'ArrowRight')).to.deep.equal({ type: 'none' });
    });

    it('ArrowRight does nothing on a file', () => {
      expect(treeKeyAction(rows, '/z.md', 'ArrowRight')).to.deep.equal({ type: 'none' });
    });

    it('ArrowLeft collapses an expanded folder', () => {
      expect(treeKeyAction(rows, '/notes', 'ArrowLeft')).to.deep.equal({
        type: 'collapse',
        path: '/notes',
      });
    });

    it('ArrowLeft moves a child out to its parent', () => {
      expect(treeKeyAction(rows, '/notes/a.md', 'ArrowLeft')).to.deep.equal({
        type: 'focus',
        path: '/notes',
      });
    });

    it('ArrowLeft does nothing at a root file', () => {
      expect(treeKeyAction(rows, '/z.md', 'ArrowLeft')).to.deep.equal({ type: 'none' });
    });

    it('enters at the first row when nothing is focused', () => {
      expect(treeKeyAction(rows, null, 'ArrowDown')).to.deep.equal({
        type: 'focus',
        path: '/notes',
      });
      expect(treeKeyAction(rows, '/stale.md', 'ArrowUp')).to.deep.equal({
        type: 'focus',
        path: '/notes',
      });
    });

    it('ignores keys it does not own, and an empty tree', () => {
      expect(treeKeyAction(rows, '/notes', 'a')).to.deep.equal({ type: 'none' });
      expect(treeKeyAction(rows, '/notes', 'Enter')).to.deep.equal({ type: 'none' });
      expect(treeKeyAction([], null, 'ArrowDown')).to.deep.equal({ type: 'none' });
    });

    it('claims exactly the keys it handles', () => {
      expect([...TREE_NAV_KEYS].sort()).to.deep.equal([
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'End',
        'Home',
      ]);
    });
  });
});
