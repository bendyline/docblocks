/**
 * parse-name-status — pure parser for NUL-terminated `git diff-tree
 * --no-commit-id --name-status -r -z --root -M <sha>` output. Yields the
 * files changed by a commit. Consumed by the git commands layer; no
 * process or fs access here.
 */

import type { GitFileStatusCode } from '@bendyline/docblocks/host';

/** Paths are TOPLEVEL-relative (no leading slash). */
export interface RawNameStatusEntry {
  path: string;
  origPath?: string;
  status: GitFileStatusCode;
}

const STATUS_BY_LETTER: Partial<Record<string, GitFileStatusCode>> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
  U: 'unmerged',
};

export function parseNameStatusZ(stdout: string): RawNameStatusEntry[] {
  const entries: RawNameStatusEntry[] = [];
  // -z output is a flat sequence of NUL-terminated tokens:
  //   STATUS NUL path NUL              (one path field)
  //   R<score>/C<score> NUL old NUL new NUL   (two path fields)
  const tokens = stdout.split('\0');
  // A trailing NUL yields one empty final token — drop it.
  if (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();

  let i = 0;
  while (i < tokens.length) {
    const statusToken = tokens[i];
    const letter = statusToken.charAt(0);
    const isTwoPath = letter === 'R' || letter === 'C';
    const pathFieldCount = isTwoPath ? 2 : 1;
    // Truncated record — not enough path fields remain.
    if (i + pathFieldCount >= tokens.length) break;
    const status = STATUS_BY_LETTER[letter];
    if (status === undefined) {
      // Unknown status letter — skip the record, consuming its path fields.
      i += 1 + pathFieldCount;
      continue;
    }
    if (isTwoPath) {
      // diff-tree -z order: old path first, then new path (reverse of
      // status porcelain v2). `path` is the NEW path.
      const origPath = tokens[i + 1];
      const path = tokens[i + 2];
      entries.push({ path, origPath, status });
    } else {
      entries.push({ path: tokens[i + 1], status });
    }
    i += 1 + pathFieldCount;
  }
  return entries;
}
