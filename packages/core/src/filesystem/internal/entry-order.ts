/**
 * Deterministic listing order shared by every filesystem provider.
 *
 * Providers must return byte-stable orderings so snapshots can be compared
 * across backends and across runs. `compareText` is deliberately a raw code
 * unit comparison rather than `localeCompare`, which is locale-dependent.
 */

import type { FileSystemEntrySnapshot } from '../v2.js';

/** Locale-independent, deterministic string ordering. */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Directory-first, then by entry name. Used for sibling listings. */
export function compareSnapshotsByName(
  left: FileSystemEntrySnapshot,
  right: FileSystemEntrySnapshot,
): number {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
  return compareText(left.name, right.name);
}

/**
 * Directory-first, then by full path.
 *
 * Equivalent to `compareSnapshotsByName` for siblings, and used where entries
 * may not share a parent — the Electron transport re-sorts host-supplied
 * listings defensively and cannot assume a single directory's children.
 */
export function compareSnapshotsByPath(
  left: FileSystemEntrySnapshot,
  right: FileSystemEntrySnapshot,
): number {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
  return compareText(left.path, right.path);
}
