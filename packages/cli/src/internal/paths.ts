import path from 'node:path';

/**
 * Load-bearing containment predicate shared by every DocBlocks CLI surface.
 *
 * `root` and `candidate` must already be the *physical* paths the caller
 * intends to compare — this function deliberately does not resolve symlinks.
 * Callers are responsible for `realpath()`ing first (see `contained-file.ts`,
 * `render-html.ts`, and `mcp/authority.ts`); this only answers "is this
 * resolved path the root itself, or below it?".
 *
 * It is a path-relationship check rather than a string-prefix check, so a
 * sibling directory that merely shares a textual prefix (`/work/docs-escape`
 * against a `/work/docs` root) is correctly rejected.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
