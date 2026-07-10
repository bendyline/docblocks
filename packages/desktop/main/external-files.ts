/**
 * Session allowlist of individual files the user has explicitly opened from
 * the OS ("Open With" / deep link) that live OUTSIDE any workspace root.
 *
 * The workspace-root whitelist (workspace-roots.ts) guards folder access; this
 * is the narrower escape hatch for single files the user pointed us at. Only
 * paths added here can be read/written via the `external:*` IPC, and the list
 * is in-memory (cleared when the app quits).
 */

import path from 'node:path';

const allowed = new Set<string>();

/** Permit read/write access to a single external file for this session. */
export function allowExternalPath(absPath: string): void {
  allowed.add(path.resolve(absPath));
}

/** True if the path was explicitly opened this session. */
export function isExternalPathAllowed(absPath: string): boolean {
  return allowed.has(path.resolve(absPath));
}
