/**
 * Routes for the shell's own pages, in the URL hash beside document routes.
 *
 * A document route is `#<workspace>/<path>` with the path percent-encoded,
 * so it never holds a raw `:`. A page route puts one straight after the
 * workspace: `#<workspace>/:home`, `#<workspace>/:tasks`, and
 * `#<workspace>/:folder/<path>` for a folder's own page. The two forms can
 * never be mistaken for each other, so a page route is checked first and a
 * document route is left to the parser that has always read it.
 */

export type ShellRoute =
  | { readonly kind: 'home' }
  | { readonly kind: 'tasks' }
  /** Ask your workspace, as a page. */
  | { readonly kind: 'ask' }
  /** A folder's page: a tasks board, a journal, the Unfiled drawer, or a plain listing. */
  | { readonly kind: 'folder'; readonly path: string };

export interface ShellPageLocation {
  readonly workspaceId: string;
  readonly route: ShellRoute;
}

/** The hash for a page of `workspaceId`. */
export function buildShellPageHash(workspaceId: string, route: ShellRoute): string {
  const workspace = encodeURIComponent(workspaceId);
  if (route.kind !== 'folder') return `#${workspace}/:${route.kind}`;
  const path = route.path.replace(/^\/+/, '');
  return path ? `#${workspace}/:folder/${encodeURIComponent(path)}` : `#${workspace}`;
}

/** The page a hash names, or null when it names a document, a workspace, or nothing. */
export function parseShellPageHash(hash: string): ShellPageLocation | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const marker = raw.indexOf('/:');
  if (marker <= 0) return null;
  let workspaceId: string;
  try {
    workspaceId = decodeURIComponent(raw.slice(0, marker));
  } catch {
    return null;
  }
  if (!workspaceId) return null;
  const rest = raw.slice(marker + 2);
  if (rest === 'home') return { workspaceId, route: { kind: 'home' } };
  if (rest === 'tasks') return { workspaceId, route: { kind: 'tasks' } };
  if (rest === 'ask') return { workspaceId, route: { kind: 'ask' } };
  if (rest.startsWith('folder/')) {
    let path: string;
    try {
      path = decodeURIComponent(rest.slice('folder/'.length));
    } catch {
      return null;
    }
    // A folder route names a folder inside the workspace, never one above it.
    const segments = path.split('/');
    if (
      !path ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      return null;
    }
    return { workspaceId, route: { kind: 'folder', path: `/${path}` } };
  }
  return null;
}

export function sameShellRoute(left: ShellRoute | null, right: ShellRoute | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;
  return left.kind !== 'folder' || left.path === (right as { path: string }).path;
}
