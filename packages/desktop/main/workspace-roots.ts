/**
 * WorkspaceRoots — whitelist of absolute directory paths this window is
 * allowed to touch. All fs IPC handlers call `resolve(id, relPath)` which
 * (a) rejects IDs that were never registered and (b) ensures the fully
 * resolved absolute path stays inside the registered root.
 *
 * This is the security boundary between the renderer and the native fs.
 */

import path from 'node:path';

export interface WorkspaceRootEntry {
  id: string;
  rootPath: string;
}

let roots = new Map<string, string>();

export function isPathInside(rootAbs: string, candidateAbs: string): boolean {
  const rel = path.relative(path.resolve(rootAbs), path.resolve(candidateAbs));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

export function getWorkspaceRoots() {
  return {
    register(id: string, rootPath: string) {
      roots.set(id, path.resolve(rootPath));
    },
    unregister(id: string) {
      roots.delete(id);
    },
    list(): WorkspaceRootEntry[] {
      return [...roots.entries()].map(([id, rootPath]) => ({ id, rootPath }));
    },
    /**
     * Resolve a renderer-supplied relative path against its registered
     * root. Throws on any escape (`../`) or unregistered root.
     */
    resolve(rootPath: string, relPath: string): string {
      const abs = path.resolve(rootPath);
      const known = [...roots.values()].some((r) => r === abs);
      if (!known) {
        throw new Error(`Workspace root not registered: ${rootPath}`);
      }
      const normalized = relPath.replace(/^\/+/, '');
      const candidate = path.resolve(abs, normalized);
      if (!isPathInside(abs, candidate)) {
        throw new Error(`Path escapes workspace root: ${relPath}`);
      }
      return candidate;
    },
    /** For tests only — reset all state. */
    _reset() {
      roots = new Map();
    },
  };
}
