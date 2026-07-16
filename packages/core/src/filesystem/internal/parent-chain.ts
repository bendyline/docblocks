/**
 * Ancestor enumeration shared by every filesystem provider.
 *
 * Two variants exist because backends genuinely disagree about whether the
 * workspace root is an *entry*, and that difference is real rather than
 * accidental:
 *
 * - IndexedDB and memory store the root as a first-class directory record
 *   (IndexedDB initialization fails with `corrupt` if the root record is
 *   missing). Their parent walks must visit the root so it is version-bumped
 *   and kind-checked like any other directory.
 * - Native (File System Access) has no root record — the root *is* the
 *   directory handle the user granted, always present and never created.
 *   Visiting it would be a guaranteed no-op.
 *
 * Both orderings are root-most first, so callers that create missing parents
 * create them top-down.
 */

import { workspacePathDirname, type WorkspacePath } from '../workspace-path.js';

/**
 * Strict ancestors of `path`, excluding the workspace root.
 *
 * Use when the root is implicit and always exists.
 */
export function parentChain(path: WorkspacePath): WorkspacePath[] {
  const parents: WorkspacePath[] = [];
  let current = workspacePathDirname(path);
  while (current) {
    parents.unshift(current);
    current = workspacePathDirname(current);
  }
  return parents;
}

/**
 * Strict ancestors of `path`, including the workspace root as the first entry.
 *
 * Use when the root is a stored entry that participates in kind checks and
 * version bumps.
 */
export function parentChainWithRoot(path: WorkspacePath): WorkspacePath[] {
  const parents: WorkspacePath[] = [];
  let current = workspacePathDirname(path);
  while (true) {
    parents.unshift(current);
    if (!current) return parents;
    current = workspacePathDirname(current);
  }
}
