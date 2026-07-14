/**
 * Pure helpers mapping GitStatus onto UI concerns — file-tree badges,
 * ahead/behind chips, dirty summaries. No React, no host access.
 */

import type { GitFileChange, GitStatus } from '@bendyline/docblocks/host';

export type GitBadgeKind =
  | 'modified'
  | 'added'
  | 'untracked'
  | 'renamed'
  | 'deleted'
  | 'conflicted'
  | 'dir';

export const BADGE_GLYPHS: Record<GitBadgeKind, string> = {
  modified: 'M',
  added: 'A',
  untracked: 'U',
  renamed: 'R',
  deleted: 'D',
  conflicted: '!',
  dir: '•',
};

export const BADGE_LABELS: Record<GitBadgeKind, string> = {
  modified: 'modified',
  added: 'added',
  untracked: 'untracked',
  renamed: 'renamed',
  deleted: 'deleted',
  conflicted: 'has conflicts',
  dir: 'contains changes',
};

function normalise(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

/** True when any path segment is a dot-entry (.git, .github, .gitignore…). */
function isDotPath(path: string): boolean {
  return normalise(path)
    .split('/')
    .some((segment) => segment.startsWith('.'));
}

export function badgeKindFor(change: GitFileChange): GitBadgeKind {
  if (change.conflicted) return 'conflicted';
  if (change.worktree === 'untracked') return 'untracked';
  if (change.index === 'deleted' || change.worktree === 'deleted') return 'deleted';
  if (change.index === 'renamed' || change.worktree === 'renamed') return 'renamed';
  if (change.index === 'added' || change.worktree === 'added') return 'added';
  return 'modified';
}

/**
 * Slash-prefixed path → badge kind, including directory rollups: any
 * ancestor directory of a changed file gets a 'dir' dot (or 'conflicted'
 * when a conflicted descendant wins). Deleted files aren't in the tree, so
 * they contribute only their ancestor rollup. Dot-paths are excluded so a
 * `.gitignore` edit doesn't inexplicably dot the root.
 */
export function buildBadgeMap(changes: readonly GitFileChange[]): Map<string, GitBadgeKind> {
  const badges = new Map<string, GitBadgeKind>();
  const dirKinds = new Map<string, GitBadgeKind>();

  for (const change of changes) {
    if (isDotPath(change.path)) continue;
    const filePath = normalise(change.path);
    const kind = badgeKindFor(change);
    if (kind !== 'deleted') {
      badges.set(filePath, kind);
    }
    const segments = filePath.split('/').slice(1, -1);
    let dir = '';
    for (const segment of segments) {
      dir += `/${segment}`;
      const rollup = kind === 'conflicted' ? 'conflicted' : 'dir';
      if (dirKinds.get(dir) !== 'conflicted') dirKinds.set(dir, rollup);
    }
  }
  for (const [dir, kind] of dirKinds) {
    if (!badges.has(dir)) badges.set(dir, kind);
  }
  return badges;
}

/** "2↑ 1↓" — empty string when neither applies. */
export function formatAheadBehind(status: Pick<GitStatus, 'ahead' | 'behind'>): string {
  const parts: string[] = [];
  if (status.ahead > 0) parts.push(`${status.ahead}↑`);
  if (status.behind > 0) parts.push(`${status.behind}↓`);
  return parts.join(' ');
}

export function isFileDirty(status: GitStatus | null, path: string | null): boolean {
  if (!status || !path) return false;
  const target = normalise(path);
  return status.changes.some((c) => normalise(c.path) === target);
}

export function conflictedPaths(status: GitStatus | null): string[] {
  if (!status) return [];
  return status.changes.filter((c) => c.conflicted).map((c) => normalise(c.path));
}

/** "3 changes" / "1 change" / "" when clean. */
export function summarizeDirty(status: GitStatus | null): string {
  const count = status?.changes.length ?? 0;
  if (count === 0) return '';
  return count === 1 ? '1 change' : `${count} changes`;
}
