/**
 * parse-status — pure parser for the stdout of
 * `git status --porcelain=v2 --branch --untracked-files=all -z`.
 *
 * Records are NUL-terminated (not newline). Header records start with '# ';
 * changed/renamed/unmerged/untracked/ignored records start with '1', '2',
 * 'u', '?', '!'. Renamed/copied ('2') records are followed by a SEPARATE
 * NUL-separated field holding the original path. Paths in the result are
 * TOPLEVEL-relative (no leading slash) — the command layer remaps them to
 * workspace-relative paths.
 */

import type { GitFileStatusCode } from '@bendyline/docblocks/host';

/** Entry with TOPLEVEL-relative path (no leading slash) — caller remaps to workspace-relative. */
export interface RawStatusEntry {
  path: string;
  /** Renames/copies: the original path. */
  origPath?: string;
  /** Staged side (X), absent when '.'. */
  index?: GitFileStatusCode;
  /** Unstaged side (Y), absent when '.'. */
  worktree?: GitFileStatusCode;
  conflicted: boolean;
}

export interface RawStatus {
  /** null when detached or no branch header. */
  branch: string | null;
  detached: boolean;
  /** '# branch.oid (initial)'. */
  unborn: boolean;
  /** Full sha, null when unborn. */
  head: string | null;
  /** '# branch.upstream origin/main'. */
  upstream: string | null;
  /** From '# branch.ab +A -B'; 0 when absent. */
  ahead: number;
  behind: number;
  entries: RawStatusEntry[];
  /** True when entries were capped at maxEntries. */
  truncated: boolean;
}

const DEFAULT_MAX_ENTRIES = 5000;

/** XY status letters → wire codes. '.' (unmodified side) maps to undefined. */
const XY_CODES: Record<string, GitFileStatusCode> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
};

function codeFor(letter: string | undefined): GitFileStatusCode | undefined {
  return letter === undefined ? undefined : XY_CODES[letter];
}

/**
 * Split `record` into `n` leading space-separated tokens plus the remainder
 * (the path, which may itself contain spaces). Returns null when the record
 * has fewer than `n` space-separated fields.
 */
function splitTokens(record: string, n: number): { tokens: string[]; rest: string } | null {
  const tokens: string[] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const space = record.indexOf(' ', start);
    if (space === -1) return null;
    tokens.push(record.slice(start, space));
    start = space + 1;
  }
  return { tokens, rest: record.slice(start) };
}

function makeChangedEntry(xy: string, path: string): RawStatusEntry {
  const entry: RawStatusEntry = { path, conflicted: false };
  const index = codeFor(xy[0]);
  const worktree = codeFor(xy[1]);
  if (index !== undefined) entry.index = index;
  if (worktree !== undefined) entry.worktree = worktree;
  return entry;
}

function pushEntry(status: RawStatus, maxEntries: number, entry: RawStatusEntry): void {
  if (status.entries.length >= maxEntries) {
    status.truncated = true;
    return;
  }
  status.entries.push(entry);
}

function parseHeader(record: string, status: RawStatus): void {
  const body = record.slice(2); // strip '# '
  const space = body.indexOf(' ');
  if (space === -1) return;
  const key = body.slice(0, space);
  const value = body.slice(space + 1);
  switch (key) {
    case 'branch.oid':
      if (value === '(initial)') {
        status.unborn = true;
        status.head = null;
      } else {
        status.head = value;
      }
      break;
    case 'branch.head':
      if (value === '(detached)') {
        status.detached = true;
        status.branch = null;
      } else {
        status.branch = value;
      }
      break;
    case 'branch.upstream':
      status.upstream = value;
      break;
    case 'branch.ab': {
      const match = /^\+(\d+) -(\d+)$/.exec(value);
      if (match) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
      break;
    }
    default:
      break; // unknown header — skip
  }
}

/**
 * Parse porcelain v2 `-z` output into a RawStatus. Robust to empty input,
 * trailing NUL, unknown record types (skipped), and paths containing spaces
 * or non-ASCII characters. Entries are capped at `maxEntries` (default 5000);
 * when the cap is hit, `truncated` is set and further entries are dropped.
 */
export function parseStatusPorcelainV2(
  stdout: string,
  maxEntries: number = DEFAULT_MAX_ENTRIES,
): RawStatus {
  const status: RawStatus = {
    branch: null,
    detached: false,
    unborn: false,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    entries: [],
    truncated: false,
  };
  if (stdout === '') return status;

  const records = stdout.split('\u0000');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record === '') continue; // trailing NUL / empty fields

    if (record.startsWith('# ')) {
      parseHeader(record, status);
    } else if (record.startsWith('1 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const split = splitTokens(record, 8);
      if (split === null) continue;
      pushEntry(status, maxEntries, makeChangedEntry(split.tokens[1], split.rest));
    } else if (record.startsWith('2 ')) {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> NUL <origPath>
      const split = splitTokens(record, 9);
      // Always consume the separate NUL field holding the original path, even
      // when the entry itself is malformed or dropped by the cap, so that
      // subsequent records stay aligned.
      i += 1;
      const origPath = records[i];
      if (split === null) continue;
      const entry = makeChangedEntry(split.tokens[1], split.rest);
      if (origPath !== undefined && origPath !== '') entry.origPath = origPath;
      pushEntry(status, maxEntries, entry);
    } else if (record.startsWith('u ')) {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const split = splitTokens(record, 10);
      if (split === null) continue;
      pushEntry(status, maxEntries, {
        path: split.rest,
        index: 'unmerged',
        worktree: 'unmerged',
        conflicted: true,
      });
    } else if (record.startsWith('? ')) {
      pushEntry(status, maxEntries, {
        path: record.slice(2),
        worktree: 'untracked',
        conflicted: false,
      });
    } else if (record.startsWith('! ')) {
      pushEntry(status, maxEntries, {
        path: record.slice(2),
        worktree: 'ignored',
        conflicted: false,
      });
    }
    // Unknown record types are skipped.
  }
  return status;
}
