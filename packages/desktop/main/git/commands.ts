/**
 * Git operation layer — one exported function per operation, each building a
 * fixed argv internally. There is no generic "run arbitrary git" surface,
 * even module-internally: renderer input enters only as validated data
 * (branch names, SHAs), `-m <message>` values, or pathspecs after `--`.
 *
 * Paths in results are workspace-root-relative and slash-prefixed (the fs
 * API convention); git itself speaks toplevel-relative paths, so entries are
 * remapped here. No electron imports — this module is unit-testable.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import type {
  GitBranchInfo,
  GitError,
  GitFileAtRevision,
  GitFileChange,
  GitFileStatusCode,
  GitLogEntry,
  GitLogOptions,
  GitRemoteInfo,
  GitRepoDetection,
  GitResult,
  GitRevision,
  GitStatus,
} from '@bendyline/docblocks/host';
import { HOST_WIRE_LIMITS, isBoundedString } from '@bendyline/docblocks/host';
import {
  NETWORK_TIMEOUT_MS,
  runGit,
  withRepoLock,
  type RunGitOptions,
  type RunGitResult,
} from './exec.js';
import { classifyGitError, makeGitError } from './errors.js';
import { parseStatusPorcelainV2 } from './parse-status.js';
import { LOG_FORMAT, parseLog } from './parse-log.js';
import { FOR_EACH_REF_FORMAT, parseForEachRef } from './parse-refs.js';
import { parseNameStatusZ } from './parse-name-status.js';
import { parseRemoteUrl } from './parse-remote-url.js';
import { isValidBranchName, isValidRemoteName, isValidSha } from './validate.js';

/** Resolved once per workspace root by detectRepo, then passed to every op. */
export interface RepoContext {
  gitBin: string;
  /** Absolute registered workspace root. */
  workspaceRoot: string;
  /** Absolute repo work-tree top level (equals workspaceRoot in the common case). */
  toplevel: string;
  /** Absolute per-worktree git dir (where MERGE_HEAD etc. live). */
  gitDir: string;
  /** Absolute common git dir (where refs/ lives; differs under linked worktrees). */
  commonDir: string;
}

const MAX_COMMIT_MESSAGE = 100 * 1024;
const MAX_LOG_COUNT = 1000;
const MAX_FILE_AT_REVISION = 10 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;

const ok = <T>(value: T): GitResult<T> => ({ ok: true, value });
const err = <T>(error: GitError): GitResult<T> => ({ ok: false, error });

function sameFileSystemPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

/** Run against the exact repository identity that the main process granted. */
function runRepoGit(
  ctx: RepoContext,
  options: Omit<RunGitOptions, 'bin' | 'cwd' | 'extraEnv'>,
): Promise<RunGitResult> {
  return runGit({
    ...options,
    bin: ctx.gitBin,
    cwd: ctx.workspaceRoot,
    extraEnv: {
      GIT_DIR: ctx.gitDir,
      GIT_WORK_TREE: ctx.toplevel,
      GIT_DISCOVERY_ACROSS_FILESYSTEM: '0',
    },
  });
}

function runError<T>(res: RunGitResult, fallback: string): GitResult<T> {
  if (res.timedOut) {
    return err({ code: 'timeout', message: 'git timed out', stderr: res.stderr || undefined });
  }
  const fromStderr = makeGitError(res.code, res.stderr, fallback);
  if (fromStderr.code !== 'unknown') return err(fromStderr);
  // Some failures report on stdout instead — `git pull` prints
  // "CONFLICT … Automatic merge failed" there while stderr only carries
  // fetch noise ("From <url>…"), and `git commit` prints "nothing to
  // commit" there with an empty stderr.
  const fromStdout = makeGitError(res.code, res.stdout.toString('utf8'), fallback);
  return err(fromStdout.code !== 'unknown' ? fromStdout : fromStderr);
}

/** Toplevel-relative (posix) → workspace-relative slash-prefixed, or null when outside. */
function toWorkspacePath(ctx: RepoContext, toplevelRelative: string): string | null {
  const abs = path.resolve(ctx.toplevel, toplevelRelative);
  const rel = path.relative(ctx.workspaceRoot, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return '/' + rel.split(path.sep).join('/');
}

/** Workspace-relative → toplevel-relative posix path; throws on escape. */
function toToplevelPath(ctx: RepoContext, workspacePath: string): string {
  const cleaned = workspacePath.replace(/^\/+/, '');
  const abs = path.resolve(ctx.workspaceRoot, cleaned);
  const insideWorkspace = path.relative(ctx.workspaceRoot, abs);
  if (insideWorkspace.startsWith('..') || path.isAbsolute(insideWorkspace)) {
    throw new Error(`Path escapes workspace root: ${workspacePath}`);
  }
  const rel = path.relative(ctx.toplevel, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes repository: ${workspacePath}`);
  }
  return rel.split(path.sep).join('/');
}

function toToplevelPaths(ctx: RepoContext, workspacePaths: string[]): string[] {
  return workspacePaths.map((p) => toToplevelPath(ctx, p));
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export async function detectRepo(
  gitBin: string,
  workspaceRoot: string,
): Promise<{ detection: GitRepoDetection; context: RepoContext | null }> {
  // git reports realpath'd locations; realpath the root too, or a workspace
  // reached via symlink (macOS /var → /private/var) never matches toplevel
  // and every path remap "escapes" the repository.
  const realRoot = await fs.realpath(workspaceRoot).catch(() => path.resolve(workspaceRoot));
  const res = await runGit({
    bin: gitBin,
    cwd: realRoot,
    args: ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
  });
  if (res.code !== 0) {
    return { detection: { isRepo: false }, context: null };
  }
  const [toplevelRaw, gitDirRaw, commonDirRaw] = res.stdout.toString('utf8').split('\n');
  if (!toplevelRaw || !gitDirRaw) {
    return { detection: { isRepo: false }, context: null };
  }
  const toplevelLexical = path.resolve(toplevelRaw.trim());
  const gitDirLexical = path.resolve(gitDirRaw.trim());
  // --git-common-dir may be relative to the cwd.
  const commonDirLexical = path.resolve(realRoot, (commonDirRaw ?? gitDirRaw).trim());
  const [toplevel, gitDir, commonDir] = await Promise.all([
    fs.realpath(toplevelLexical),
    fs.realpath(gitDirLexical),
    fs.realpath(commonDirLexical),
  ]);
  const context: RepoContext = {
    gitBin,
    workspaceRoot: realRoot,
    toplevel,
    gitDir,
    commonDir,
  };
  return {
    detection: {
      isRepo: true,
      rootIsToplevel: sameFileSystemPath(context.workspaceRoot, toplevel),
    },
    context,
  };
}

export async function init(gitBin: string, workspaceRoot: string): Promise<GitResult<void>> {
  const res = await runGit({ bin: gitBin, cwd: workspaceRoot, args: ['init'] });
  if (res.code !== 0) return runError(res, 'git init failed');
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function detectOperation(ctx: RepoContext): Promise<GitStatus['operation']> {
  const inGitDir = (name: string) => path.join(ctx.gitDir, name);
  if (await pathExists(inGitDir('MERGE_HEAD'))) return 'merge';
  if (
    (await pathExists(inGitDir('rebase-merge'))) ||
    (await pathExists(inGitDir('rebase-apply')))
  ) {
    return 'rebase';
  }
  if (await pathExists(inGitDir('CHERRY_PICK_HEAD'))) return 'cherry-pick';
  if (await pathExists(inGitDir('REVERT_HEAD'))) return 'revert';
  if (await pathExists(inGitDir('BISECT_LOG'))) return 'bisect';
  return null;
}

export async function status(ctx: RepoContext): Promise<GitResult<GitStatus>> {
  const scoped = !sameFileSystemPath(ctx.workspaceRoot, ctx.toplevel);
  const args = ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'];
  if (scoped) args.push('--', '.');
  const res = await runRepoGit(ctx, { args });
  if (res.code !== 0) return runError(res, 'git status failed');

  const raw = parseStatusPorcelainV2(res.stdout.toString('utf8'));
  const changes: GitFileChange[] = [];
  for (const entry of raw.entries) {
    const workspacePath = toWorkspacePath(ctx, entry.path);
    if (workspacePath === null) continue;
    const origPath = entry.origPath
      ? (toWorkspacePath(ctx, entry.origPath) ?? undefined)
      : undefined;
    changes.push({
      path: workspacePath,
      origPath,
      index: entry.index,
      worktree: entry.worktree,
      conflicted: entry.conflicted,
    });
  }
  return ok({
    branch: raw.branch,
    detached: raw.detached,
    unborn: raw.unborn,
    head: raw.head,
    upstream: raw.upstream,
    ahead: raw.ahead,
    behind: raw.behind,
    changes,
    truncated: raw.truncated,
    operation: await detectOperation(ctx),
  });
}

// ---------------------------------------------------------------------------
// Working-tree mutations
// ---------------------------------------------------------------------------

function requirePaths(paths: string[]): GitResult<void> | null {
  if (paths.length === 0) {
    return err({ code: 'unknown', message: 'No paths given' });
  }
  return null;
}

export async function stage(ctx: RepoContext, paths: string[]): Promise<GitResult<void>> {
  const bad = requirePaths(paths);
  if (bad) return bad;
  return withRepoLock(ctx.toplevel, async () => {
    const res = await runRepoGit(ctx, {
      args: ['add', '-A', '--', ...toToplevelPaths(ctx, paths)],
    });
    if (res.code !== 0) return runError<void>(res, 'git add failed');
    return ok(undefined);
  });
}

export async function unstage(ctx: RepoContext, paths: string[]): Promise<GitResult<void>> {
  const bad = requirePaths(paths);
  if (bad) return bad;
  return withRepoLock(ctx.toplevel, async () => {
    const rels = toToplevelPaths(ctx, paths);
    const res = await runRepoGit(ctx, {
      args: ['restore', '--staged', '--', ...rels],
    });
    if (res.code === 0) return ok(undefined);
    // Unborn HEAD: `restore --staged` has no HEAD to restore from.
    const fallback = await runRepoGit(ctx, {
      args: ['rm', '--cached', '-r', '--quiet', '--', ...rels],
    });
    if (fallback.code === 0) return ok(undefined);
    return runError<void>(res, 'git restore --staged failed');
  });
}

/** Revert tracked files to HEAD; delete untracked ones. Destructive. */
export async function discard(ctx: RepoContext, paths: string[]): Promise<GitResult<void>> {
  const bad = requirePaths(paths);
  if (bad) return bad;
  return withRepoLock(ctx.toplevel, async () => {
    const current = await status(ctx);
    if (!current.ok) return current as GitResult<void>;
    const untracked = new Set(
      current.value.changes.filter((c) => c.worktree === 'untracked').map((c) => c.path),
    );
    const normalized = paths.map((p) => (p.startsWith('/') ? p : `/${p}`));
    const untrackedTargets = normalized.filter((p) => untracked.has(p));
    const trackedTargets = normalized.filter((p) => !untracked.has(p));

    if (trackedTargets.length > 0) {
      const res = await runRepoGit(ctx, {
        args: [
          'restore',
          '--staged',
          '--worktree',
          '--source=HEAD',
          '--',
          ...toToplevelPaths(ctx, trackedTargets),
        ],
      });
      if (res.code !== 0) return runError<void>(res, 'git restore failed');
    }
    for (const target of untrackedTargets) {
      const cleaned = target.replace(/^\/+/, '');
      const abs = path.resolve(ctx.workspaceRoot, cleaned);
      const rel = path.relative(ctx.workspaceRoot, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      await fs.rm(abs, { force: true });
    }
    return ok(undefined);
  });
}

export async function commit(
  ctx: RepoContext,
  message: string,
  paths?: string[],
): Promise<GitResult<{ sha: string }>> {
  // Git cannot represent NUL in a commit message; strip rather than reject.
  // eslint-disable-next-line no-control-regex
  const cleanedMessage = message.replace(/\u0000/g, '').slice(0, MAX_COMMIT_MESSAGE);
  if (cleanedMessage.trim().length === 0) {
    return err({ code: 'unknown', message: 'Commit message is empty' });
  }
  return withRepoLock(ctx.toplevel, async () => {
    const rels = paths && paths.length > 0 ? toToplevelPaths(ctx, paths) : null;
    if (rels) {
      const added = await runRepoGit(ctx, {
        args: ['add', '-A', '--', ...rels],
      });
      if (added.code !== 0) return runError<{ sha: string }>(added, 'git add failed');
    }
    // Git forbids a partial (pathspec) commit while a merge/cherry-pick/revert
    // is in progress — it must record the whole index. So stage the resolved
    // paths above, but drop the pathspec from the commit when mid-operation.
    const operation = await detectOperation(ctx);
    const commitArgs = ['commit', '-m', cleanedMessage];
    if (rels && operation === null) commitArgs.push('--', ...rels);
    const committed = await runRepoGit(ctx, { args: commitArgs });
    if (committed.code !== 0) {
      // `git commit` reports "nothing to commit" on STDOUT with an empty
      // stderr, which the stderr-only classifier would map to 'unknown'.
      if (!committed.timedOut && committed.stderr.trim().length === 0) {
        const stdoutCode = classifyGitError(committed.code, committed.stdout.toString('utf8'));
        if (stdoutCode === 'nothing-to-commit') {
          const error: GitError = { code: stdoutCode, message: 'Nothing to commit' };
          if (committed.code !== null) error.exitCode = committed.code;
          return err(error);
        }
      }
      return runError<{ sha: string }>(committed, 'git commit failed');
    }

    const head = await runRepoGit(ctx, {
      args: ['rev-parse', 'HEAD'],
    });
    if (head.code !== 0) return runError<{ sha: string }>(head, 'git rev-parse failed');
    return ok({ sha: head.stdout.toString('utf8').trim() });
  });
}

// ---------------------------------------------------------------------------
// Remote operations
// ---------------------------------------------------------------------------

export async function push(
  ctx: RepoContext,
  opts?: { setUpstream?: boolean },
): Promise<GitResult<void>> {
  return withRepoLock(ctx.toplevel, async () => {
    const args = ['push'];
    if (opts?.setUpstream) {
      const remotes = await listRemotes(ctx);
      if (!remotes.ok) return remotes as GitResult<void>;
      const remote = remotes.value[0]?.name;
      if (!remote || !isValidRemoteName(remote)) {
        return err<void>({ code: 'remote-not-found', message: 'No remote configured' });
      }
      args.push('-u', remote, 'HEAD');
    }
    const res = await runRepoGit(ctx, {
      args,
      timeoutMs: NETWORK_TIMEOUT_MS,
    });
    if (res.code !== 0) return runError<void>(res, 'git push failed');
    return ok(undefined);
  });
}

export async function pull(ctx: RepoContext): Promise<GitResult<void>> {
  return withRepoLock(ctx.toplevel, async () => {
    const res = await runRepoGit(ctx, {
      args: ['pull', '--no-rebase'],
      timeoutMs: NETWORK_TIMEOUT_MS,
    });
    if (res.code !== 0) return runError<void>(res, 'git pull failed');
    return ok(undefined);
  });
}

export async function fetch(ctx: RepoContext): Promise<GitResult<void>> {
  return withRepoLock(ctx.toplevel, async () => {
    const res = await runRepoGit(ctx, {
      args: ['fetch', '--all', '--prune'],
      timeoutMs: NETWORK_TIMEOUT_MS,
    });
    if (res.code !== 0) return runError<void>(res, 'git fetch failed');
    return ok(undefined);
  });
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export async function listBranches(ctx: RepoContext): Promise<GitResult<GitBranchInfo[]>> {
  const res = await runRepoGit(ctx, {
    args: ['for-each-ref', 'refs/heads', 'refs/remotes', `--format=${FOR_EACH_REF_FORMAT}`],
  });
  if (res.code !== 0) return runError(res, 'git for-each-ref failed');
  return ok(parseForEachRef(res.stdout.toString('utf8')).slice(0, HOST_WIRE_LIMITS.arrayEntries));
}

export async function createBranch(
  ctx: RepoContext,
  name: string,
  opts?: { checkout?: boolean },
): Promise<GitResult<void>> {
  if (!isValidBranchName(name)) {
    return err({ code: 'invalid-ref-name', message: `Invalid branch name: ${name}` });
  }
  return withRepoLock(ctx.toplevel, async () => {
    const args = opts?.checkout === false ? ['branch', '--', name] : ['switch', '-c', name];
    const res = await runRepoGit(ctx, { args });
    if (res.code !== 0) return runError<void>(res, 'git branch creation failed');
    return ok(undefined);
  });
}

export async function checkoutBranch(ctx: RepoContext, name: string): Promise<GitResult<void>> {
  if (!isValidBranchName(name)) {
    return err({ code: 'invalid-ref-name', message: `Invalid branch name: ${name}` });
  }
  return withRepoLock(ctx.toplevel, async () => {
    const res = await runRepoGit(ctx, { args: ['switch', name] });
    if (res.code !== 0) return runError<void>(res, 'git switch failed');
    return ok(undefined);
  });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function log(
  ctx: RepoContext,
  opts?: GitLogOptions,
): Promise<GitResult<GitLogEntry[]>> {
  const maxCount = Math.min(Math.max(opts?.maxCount ?? 100, 1), MAX_LOG_COUNT);
  const args = ['log', `--format=${LOG_FORMAT}`, '-n', String(maxCount)];
  if (opts?.skip && opts.skip > 0) args.push('--skip', String(Math.floor(opts.skip)));
  if (opts?.path) {
    args.push('--follow', '--', toToplevelPath(ctx, opts.path));
  }
  const res = await runRepoGit(ctx, { args });
  if (res.code !== 0) {
    const failure = runError<GitLogEntry[]>(res, 'git log failed');
    // An unborn branch simply has no history yet.
    if (!failure.ok && failure.error.code === 'unborn-branch') return ok([]);
    return failure;
  }
  return ok(parseLog(res.stdout.toString('utf8')));
}

export async function commitFiles(
  ctx: RepoContext,
  sha: string,
): Promise<GitResult<{ body: string; files: GitFileChange[] }>> {
  if (!isValidSha(sha)) {
    return err({ code: 'unknown', message: `Invalid commit id: ${sha}` });
  }
  const bodyRes = await runRepoGit(ctx, {
    args: ['log', '-1', '--format=%B', sha],
  });
  if (bodyRes.code !== 0) return runError(bodyRes, 'git log failed');

  const filesRes = await runRepoGit(ctx, {
    args: ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '--root', '-M', sha],
  });
  if (filesRes.code !== 0) return runError(filesRes, 'git diff-tree failed');

  const files: GitFileChange[] = [];
  for (const entry of parseNameStatusZ(filesRes.stdout.toString('utf8'))) {
    if (files.length >= HOST_WIRE_LIMITS.arrayEntries) break;
    const workspacePath = toWorkspacePath(ctx, entry.path);
    if (workspacePath === null) continue;
    files.push({
      path: workspacePath,
      origPath: entry.origPath ? (toWorkspacePath(ctx, entry.origPath) ?? undefined) : undefined,
      index: entry.status,
      conflicted: false,
    });
  }
  return ok({ body: bodyRes.stdout.toString('utf8').trimEnd(), files });
}

const MISSING_AT_REVISION =
  /does not exist in|exists on disk, but not in|invalid object name|bad revision|unknown revision|path .* does not exist/i;

export async function readFileAtRevision(
  ctx: RepoContext,
  workspacePath: string,
  revision: GitRevision,
): Promise<GitResult<GitFileAtRevision>> {
  const rel = toToplevelPath(ctx, workspacePath);
  let spec: string;
  switch (revision.kind) {
    case 'head':
      spec = `HEAD:${rel}`;
      break;
    case 'index':
      spec = `:0:${rel}`;
      break;
    case 'commit':
      if (!isValidSha(revision.sha)) {
        return err({ code: 'unknown', message: `Invalid commit id: ${revision.sha}` });
      }
      spec = `${revision.sha}:${rel}`;
      break;
    case 'parent-of':
      if (!isValidSha(revision.sha)) {
        return err({ code: 'unknown', message: `Invalid commit id: ${revision.sha}` });
      }
      spec = `${revision.sha}^:${rel}`;
      break;
    default:
      return err({ code: 'unknown', message: 'Invalid revision selector' });
  }

  const res = await runRepoGit(ctx, {
    args: ['show', spec],
    maxStdoutBytes: MAX_FILE_AT_REVISION + 1,
  });
  if (res.code !== 0) {
    if (MISSING_AT_REVISION.test(res.stderr)) {
      return ok({ content: null, binary: false });
    }
    return runError(res, 'git show failed');
  }
  if (res.stdout.length > MAX_FILE_AT_REVISION) {
    return ok({ content: null, binary: true });
  }
  const sniff = res.stdout.subarray(0, BINARY_SNIFF_BYTES);
  if (sniff.includes(0)) {
    return ok({ content: null, binary: true });
  }
  return ok({ content: res.stdout.toString('utf8'), binary: false });
}

// ---------------------------------------------------------------------------
// Remotes
// ---------------------------------------------------------------------------

export async function listRemotes(ctx: RepoContext): Promise<GitResult<GitRemoteInfo[]>> {
  const res = await runRepoGit(ctx, { args: ['remote', '-v'] });
  if (res.code !== 0) return runError(res, 'git remote failed');

  const byName = new Map<string, { fetchUrl?: string; pushUrl?: string }>();
  for (const line of res.stdout.toString('utf8').split('\n')) {
    const match = /^(\S+)\t(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const [, name, url, kind] = match;
    if (!isValidRemoteName(name) || !isBoundedString(url, HOST_WIRE_LIMITS.urlCharacters, 1)) {
      continue;
    }
    const entry = byName.get(name) ?? {};
    if (kind === 'fetch') entry.fetchUrl = url;
    else entry.pushUrl = url;
    byName.set(name, entry);
  }
  const remotes: GitRemoteInfo[] = [];
  for (const [name, urls] of byName) {
    if (remotes.length >= HOST_WIRE_LIMITS.arrayEntries) break;
    const fetchUrl = urls.fetchUrl ?? urls.pushUrl;
    if (!fetchUrl) continue;
    const parsedWeb = parseRemoteUrl(fetchUrl);
    const web =
      parsedWeb &&
      isBoundedString(parsedWeb.webUrl, HOST_WIRE_LIMITS.urlCharacters, 1) &&
      isBoundedString(parsedWeb.host, HOST_WIRE_LIMITS.labelCharacters, 1) &&
      isBoundedString(parsedWeb.owner, HOST_WIRE_LIMITS.pathCharacters, 1) &&
      isBoundedString(parsedWeb.repo, HOST_WIRE_LIMITS.labelCharacters, 1)
        ? parsedWeb
        : null;
    remotes.push({ name, web });
  }
  // Keep "origin" first for the common case.
  remotes.sort((a, b) =>
    a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : a.name.localeCompare(b.name),
  );
  return ok(remotes);
}

export type { GitFileStatusCode };
