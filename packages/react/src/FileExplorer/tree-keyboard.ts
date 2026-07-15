/**
 * File-tree keyboard navigation — pure decision logic, unit-testable.
 *
 * Implements the key contract from the WAI-ARIA tree-view pattern against a
 * *flattened list of currently-visible rows*. Flattening first is what
 * makes the rules trivial: a collapsed folder's children simply aren't in
 * the list, so Arrow Up/Down skip them for free, and "move to parent" is a
 * lookup rather than a walk back up the render tree.
 *
 * The caller owns focus and expansion; these helpers only say what should
 * happen. See FileExplorer, which flattens the tree it renders and applies
 * the returned action.
 */

import type { FileSystemEntry } from '@bendyline/docblocks/filesystem';

export interface TreeRow {
  path: string;
  kind: 'file' | 'directory';
  /** 0 for a root row; mirrors the rendered indentation. */
  depth: number;
  /** Directories only — always false for a file. */
  expanded: boolean;
  /** null for a root row. */
  parentPath: string | null;
}

/** How the tree is shaped, injected so this module stays free of state. */
export interface TreeShape {
  roots: readonly FileSystemEntry[];
  childrenOf: (dirPath: string) => readonly FileSystemEntry[];
  isExpanded: (dirPath: string) => boolean;
  /** Mirrors the explorer's hidden-entry filter so order matches the DOM. */
  isVisible: (entry: FileSystemEntry) => boolean;
}

export type TreeKeyAction =
  | { type: 'none' }
  | { type: 'focus'; path: string }
  | { type: 'expand'; path: string }
  | { type: 'collapse'; path: string };

const NONE: TreeKeyAction = { type: 'none' };

/** Keys this module claims; the caller should preventDefault for these. */
export const TREE_NAV_KEYS: ReadonlySet<string> = new Set([
  'ArrowDown',
  'ArrowUp',
  'ArrowRight',
  'ArrowLeft',
  'Home',
  'End',
]);

/**
 * Depth-first list of the rows the tree is currently rendering, in visual
 * order. Must stay in step with FileExplorer's `renderEntries`.
 */
export function flattenVisibleRows(shape: TreeShape): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (entries: readonly FileSystemEntry[], depth: number, parentPath: string | null) => {
    for (const entry of entries) {
      if (!shape.isVisible(entry)) continue;
      const expanded = entry.kind === 'directory' && shape.isExpanded(entry.path);
      rows.push({ path: entry.path, kind: entry.kind, depth, expanded, parentPath });
      if (expanded) walk(shape.childrenOf(entry.path), depth + 1, entry.path);
    }
  };
  walk(shape.roots, 0, null);
  return rows;
}

/**
 * The single tab stop for the tree (roving tabindex). Prefers the row the
 * user last focused, falls back to the selected document, then the first
 * row — so tabbing into the tree lands somewhere meaningful and never
 * leaves the tree unreachable.
 */
export function resolveActiveRow(
  rows: readonly TreeRow[],
  activePath: string | null,
  selectedPath: string | null,
): string | null {
  const has = (path: string | null): path is string =>
    path !== null && rows.some((row) => row.path === path);
  if (has(activePath)) return activePath;
  if (has(selectedPath)) return selectedPath;
  return rows[0]?.path ?? null;
}

/** Decide what a navigation key does. Returns `none` for unclaimed keys. */
export function treeKeyAction(
  rows: readonly TreeRow[],
  activePath: string | null,
  key: string,
): TreeKeyAction {
  if (rows.length === 0) return NONE;

  if (key === 'Home') return { type: 'focus', path: rows[0].path };
  if (key === 'End') return { type: 'focus', path: rows[rows.length - 1].path };

  const index = activePath === null ? -1 : rows.findIndex((row) => row.path === activePath);
  // Nothing (or something stale) focused: any arrow key enters at the top.
  if (index < 0) return TREE_NAV_KEYS.has(key) ? { type: 'focus', path: rows[0].path } : NONE;
  const row = rows[index];

  switch (key) {
    case 'ArrowDown': {
      const next = rows[index + 1];
      return next ? { type: 'focus', path: next.path } : NONE;
    }
    case 'ArrowUp': {
      const previous = rows[index - 1];
      return previous ? { type: 'focus', path: previous.path } : NONE;
    }
    case 'ArrowRight': {
      if (row.kind !== 'directory') return NONE;
      if (!row.expanded) return { type: 'expand', path: row.path };
      const child = rows[index + 1];
      // Only descend when the next row really is this folder's child: an
      // expanded-but-empty folder must not jump to its sibling.
      return child && child.parentPath === row.path ? { type: 'focus', path: child.path } : NONE;
    }
    case 'ArrowLeft': {
      // An open folder closes; anything else steps out to its parent.
      if (row.kind === 'directory' && row.expanded) return { type: 'collapse', path: row.path };
      return row.parentPath === null ? NONE : { type: 'focus', path: row.parentPath };
    }
    default:
      return NONE;
  }
}
