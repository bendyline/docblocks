/**
 * Commit-dialog selection state — pure helpers, unit-testable.
 *
 * All changed files are included by default. While a merge is being
 * concluded, conflicted files are force-included: committing a subset that
 * omits them would not resolve the merge.
 */

import type { GitFileChange, GitStatus } from '@bendyline/docblocks/host';

export interface CommitSelection {
  /** Slash-prefixed path → include in the commit. */
  included: Map<string, boolean>;
  /** Paths the user cannot exclude (conflicted files during a merge). */
  locked: Set<string>;
}

function normalise(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

export function initSelection(
  changes: readonly GitFileChange[],
  merging: boolean,
): CommitSelection {
  const included = new Map<string, boolean>();
  const locked = new Set<string>();
  for (const change of changes) {
    const path = normalise(change.path);
    included.set(path, true);
    if (merging && change.conflicted) locked.add(path);
  }
  return { included, locked };
}

export function toggleSelection(selection: CommitSelection, path: string): CommitSelection {
  const key = normalise(path);
  if (selection.locked.has(key)) return selection;
  const included = new Map(selection.included);
  included.set(key, !included.get(key));
  return { included, locked: selection.locked };
}

export function setAllSelected(selection: CommitSelection, value: boolean): CommitSelection {
  const included = new Map<string, boolean>();
  for (const key of selection.included.keys()) {
    included.set(key, selection.locked.has(key) ? true : value);
  }
  return { included, locked: selection.locked };
}

export function selectedPaths(selection: CommitSelection): string[] {
  return [...selection.included.entries()].filter(([, on]) => on).map(([path]) => path);
}

export function canCommit(message: string, selection: CommitSelection): boolean {
  return message.trim().length > 0 && selectedPaths(selection).length > 0;
}

/** True when committing concludes an in-progress merge. */
export function isMergeCommit(status: GitStatus | null): boolean {
  return status?.operation === 'merge';
}
