/**
 * Commit-dialog selection state — pure helpers, unit-testable.
 *
 * All changed files are included by default. While a merge is being
 * concluded, conflicted files are force-included: committing a subset that
 * omits them would not resolve the merge.
 *
 * The selection is *derived* from the live change list on every render
 * rather than snapshotted when the dialog mounts. Git status refreshes
 * (autosave pushes one every 1.5s) can add or drop files while the dialog
 * is open, and a snapshot would leave those rows rendering a checkbox that
 * no longer corresponds to what gets committed. The user's explicit
 * include/exclude choices are the only thing carried across refreshes —
 * see `CommitOverrides`.
 */

import type { GitFileChange, GitStatus } from '@bendyline/docblocks/host';

/**
 * A changed file with no explicit user choice is committed. Stated once,
 * here, so the checkbox, `selectedPaths`, and the toggle all agree instead
 * of each re-deriving "included" from a key being absent.
 */
export const INCLUDED_BY_DEFAULT = true;

/**
 * The user's explicit include/exclude choices, keyed by normalised path.
 * A path absent from this map has never been touched by the user and
 * therefore takes `INCLUDED_BY_DEFAULT`. Overrides may name paths that are
 * not currently changed (a file toggled off, saved back to its committed
 * contents, then changed again keeps the user's choice); `resolveSelection`
 * ignores those until they reappear in the change list.
 */
export type CommitOverrides = ReadonlyMap<string, boolean>;

export interface CommitSelection {
  /**
   * Normalised path → include in the commit. Covers exactly the paths in
   * the change list it was resolved from, so what the dialog renders and
   * what `selectedPaths` returns cannot drift apart.
   */
  included: Map<string, boolean>;
  /** Paths the user cannot exclude (conflicted files during a merge). */
  locked: Set<string>;
}

function normalise(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

export const NO_OVERRIDES: CommitOverrides = new Map<string, boolean>();

/**
 * Resolve the live change list plus the user's choices into the selection
 * the dialog renders and commits. Pure — call it on every render.
 */
export function resolveSelection(
  changes: readonly GitFileChange[],
  merging: boolean,
  overrides: CommitOverrides = NO_OVERRIDES,
): CommitSelection {
  const included = new Map<string, boolean>();
  const locked = new Set<string>();
  for (const change of changes) {
    const path = normalise(change.path);
    const isLocked = merging && Boolean(change.conflicted);
    if (isLocked) locked.add(path);
    included.set(path, isLocked ? true : (overrides.get(path) ?? INCLUDED_BY_DEFAULT));
  }
  return { included, locked };
}

/** Whether `path` (raw or normalised) is committed under this selection. */
export function isIncluded(selection: CommitSelection, path: string): boolean {
  return selection.included.get(normalise(path)) ?? INCLUDED_BY_DEFAULT;
}

/** Whether `path` (raw or normalised) is force-included and cannot be toggled. */
export function isLocked(selection: CommitSelection, path: string): boolean {
  return selection.locked.has(normalise(path));
}

/**
 * Flip one path, returning the next overrides map. Reads the *current*
 * resolved state rather than the raw override, so the first click on a
 * never-touched (default-included) file excludes it — one click, matching
 * what its checkbox shows.
 */
export function toggleOverride(
  overrides: CommitOverrides,
  selection: CommitSelection,
  path: string,
): CommitOverrides {
  const key = normalise(path);
  if (isLocked(selection, key)) return overrides;
  const next = new Map(overrides);
  next.set(key, !isIncluded(selection, key));
  return next;
}

/**
 * Explicitly set every currently-changed file. Locked paths are left to
 * `resolveSelection`, which force-includes them regardless.
 */
export function setAllOverrides(selection: CommitSelection, value: boolean): CommitOverrides {
  const next = new Map<string, boolean>();
  for (const key of selection.included.keys()) {
    if (!selection.locked.has(key)) next.set(key, value);
  }
  return next;
}

/** True when every currently-changed file is included. */
export function allSelected(selection: CommitSelection): boolean {
  return [...selection.included.values()].every(Boolean);
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
