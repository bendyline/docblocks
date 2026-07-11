import { FsError } from './fs-error.js';

declare const workspacePathBrand: unique symbol;

/** Canonical, root-relative, forward-slash path within one workspace. */
export type WorkspacePath = string & { readonly [workspacePathBrand]: 'WorkspacePath' };

export const WORKSPACE_ROOT = '' as WorkspacePath;

/**
 * Parse a legacy/user path into its one canonical workspace representation.
 * Leading/trailing and repeated separators are normalized; traversal and NUL
 * segments are rejected rather than resolved.
 */
export function parseWorkspacePath(input: string): WorkspacePath {
  if (
    [...input].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw invalidPath(input, 'Workspace paths must not contain NUL or other control characters.');
  }
  if (/^[a-zA-Z]:/u.test(input)) {
    throw new FsError('path-escape', 'Workspace paths must not be OS drive-qualified paths.', {
      operation: 'parse-path',
      path: input,
    });
  }

  const normalized = input
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '');
  if (!normalized) return WORKSPACE_ROOT;

  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new FsError('path-escape', 'Workspace paths must not contain "." or ".." segments.', {
      operation: 'parse-path',
      path: input,
    });
  }
  return normalized as WorkspacePath;
}

export function tryParseWorkspacePath(input: unknown): WorkspacePath | null {
  if (typeof input !== 'string') return null;
  try {
    return parseWorkspacePath(input);
  } catch {
    return null;
  }
}

/** Convert a canonical path to the slash-prefixed form accepted by v1 providers. */
export function workspacePathToLegacy(path: WorkspacePath): string {
  return path ? `/${path}` : '/';
}

export function workspacePathJoin(parent: WorkspacePath, child: string): WorkspacePath {
  const childPath = parseWorkspacePath(child);
  if (!parent) return childPath;
  if (!childPath) return parent;
  return parseWorkspacePath(`${parent}/${childPath}`);
}

export function workspacePathDirname(path: WorkspacePath): WorkspacePath {
  if (!path) return WORKSPACE_ROOT;
  const slash = path.lastIndexOf('/');
  return slash < 0 ? WORKSPACE_ROOT : (path.slice(0, slash) as WorkspacePath);
}

export function workspacePathBasename(path: WorkspacePath): string {
  if (!path) return '';
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

export function workspacePathContains(
  parent: WorkspacePath,
  candidate: WorkspacePath,
  inclusive = true,
): boolean {
  if (parent === candidate) return inclusive;
  if (!parent) return candidate !== WORKSPACE_ROOT;
  return candidate.startsWith(`${parent}/`);
}

function invalidPath(path: string, message: string): FsError {
  return new FsError('invalid-path', message, { operation: 'parse-path', path });
}
