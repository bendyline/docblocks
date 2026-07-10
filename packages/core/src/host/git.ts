/**
 * Git host API — wire types for the desktop shell's git integration.
 *
 * The desktop app spawns the user's system git from the main process, so
 * credentials (helpers, SSH agent, signing config) are inherited and never
 * touch DocBlocks. Everything here is generic git; the only host-specific
 * conveniences are remote-URL parsing (`GitRemoteInfo.web`) and PR creation
 * via the GitHub CLI when installed.
 *
 * Expected git failures cross IPC as data (`GitResult`), never as thrown
 * errors — `ipcMain.handle` rejections lose structure. Throwing is reserved
 * for contract violations (unregistered root, path escape).
 */

import type { ElectronWorkspaceInfo } from './types.js';

/** Every git operation resolves this — expected failures are data, not throws. */
export type GitResult<T> = { ok: true; value: T } | { ok: false; error: GitError };

export interface GitError {
  code: GitErrorCode;
  /** One-line human summary (classified stderr or synthesized). */
  message: string;
  /** Truncated raw stderr for a details disclosure in the UI. */
  stderr?: string;
  exitCode?: number;
}

export type GitErrorCode =
  | 'git-not-available'
  | 'not-a-repository'
  | 'auth-failed'
  | 'remote-not-found'
  | 'no-upstream'
  | 'network'
  | 'non-fast-forward'
  | 'merge-conflict'
  | 'uncommitted-changes'
  | 'detached-head'
  | 'unborn-branch'
  | 'identity-not-configured'
  | 'branch-exists'
  | 'invalid-ref-name'
  | 'nothing-to-commit'
  | 'invalid-url'
  | 'destination-exists'
  | 'pr-exists'
  | 'gh-not-available'
  | 'timeout'
  | 'cancelled'
  | 'unknown';

export interface GitCapabilities {
  /** False in store-sandboxed builds, when git is absent, or git < 2.23. */
  gitAvailable: boolean;
  gitVersion: string | null;
  ghAvailable: boolean;
  ghVersion: string | null;
}

export interface GitRepoDetection {
  isRepo: boolean;
  /** Absolute repo work-tree top level. Equals the root path in the common case. */
  toplevel?: string;
  /** False when the workspace root is a subdirectory of a larger repo. */
  rootIsToplevel?: boolean;
}

export type GitFileStatusCode =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed'
  | 'untracked'
  | 'ignored'
  | 'unmerged';

export interface GitFileChange {
  /** Slash-prefixed path relative to the WORKSPACE root (fs API convention). */
  path: string;
  /** Previous path for renames/copies (workspace-relative, slash-prefixed). */
  origPath?: string;
  /** Index-vs-HEAD state (staged), if any. */
  index?: GitFileStatusCode;
  /** Worktree-vs-index state (unstaged), if any. */
  worktree?: GitFileStatusCode;
  conflicted: boolean;
}

export interface GitStatus {
  /** Branch name; null when detached or unborn with no branch. */
  branch: string | null;
  detached: boolean;
  /** HEAD points at a branch with no commits yet. */
  unborn: boolean;
  /** Full HEAD SHA; null when unborn. */
  head: string | null;
  /** Upstream ref short name, e.g. "origin/main". */
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitFileChange[];
  /** True when `changes` was capped. */
  truncated: boolean;
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
}

export interface GitBranchInfo {
  /** "main" for local branches, "origin/main" for remote entries. */
  name: string;
  kind: 'local' | 'remote';
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  upstreamGone: boolean;
  headSha: string;
  headSubject: string;
  /** ISO 8601. */
  headDate: string;
}

export interface GitLogOptions {
  /** Workspace-relative file path — per-file history (follows renames). */
  path?: string;
  /** Default 100; the host caps at 1000. */
  maxCount?: number;
  skip?: number;
}

export interface GitLogEntry {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** ISO 8601. */
  authorDate: string;
  subject: string;
  /** Ref decorations ("HEAD -> main", "origin/main", "tag: v1"). */
  refs: string[];
}

/** Typed revision selector — the renderer never passes raw rev strings. */
export type GitRevision =
  | { kind: 'head' }
  | { kind: 'index' }
  | { kind: 'commit'; sha: string }
  | { kind: 'parent-of'; sha: string };

export interface GitFileAtRevision {
  /** Null when the file is absent at that revision, or binary/too large. */
  content: string | null;
  binary: boolean;
}

export interface GitRemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl?: string;
  /** Parsed web location, host-agnostic; null when unparseable (file:// etc.). */
  web: { host: string; owner: string; repo: string; webUrl: string } | null;
}

export interface GitCloneProgress {
  /** e.g. "Receiving objects", "Resolving deltas", "Checking out files". */
  phase: string;
  percent: number | null;
  /** Raw progress line for display. */
  detail?: string;
}

export interface GitCloneHandle {
  /**
   * Resolves `ok(null)` if the user cancels the destination picker; on
   * success resolves the registered workspace ready to open.
   */
  result: Promise<GitResult<ElectronWorkspaceInfo | null>>;
  /** Kill git and remove the partial clone directory. */
  cancel: () => void;
}

export interface DocBlocksHostGitAPI {
  capabilities(): Promise<GitCapabilities>;
  detectRepo(rootPath: string): Promise<GitResult<GitRepoDetection>>;
  init(rootPath: string): Promise<GitResult<void>>;

  status(rootPath: string): Promise<GitResult<GitStatus>>;
  stage(rootPath: string, paths: string[]): Promise<GitResult<void>>;
  unstage(rootPath: string, paths: string[]): Promise<GitResult<void>>;
  /** Revert tracked files to HEAD; delete untracked ones. Destructive — the renderer confirms. */
  discard(rootPath: string, paths: string[]): Promise<GitResult<void>>;
  /**
   * With `paths`: stages exactly those files (`add -A -- <paths>`) and commits
   * them, leaving other staged entries staged. Without: commits the index as-is.
   */
  commit(rootPath: string, message: string, paths?: string[]): Promise<GitResult<{ sha: string }>>;

  push(rootPath: string, opts?: { setUpstream?: boolean }): Promise<GitResult<void>>;
  pull(rootPath: string): Promise<GitResult<void>>;
  fetch(rootPath: string): Promise<GitResult<void>>;

  listBranches(rootPath: string): Promise<GitResult<GitBranchInfo[]>>;
  createBranch(
    rootPath: string,
    name: string,
    opts?: { checkout?: boolean },
  ): Promise<GitResult<void>>;
  checkoutBranch(rootPath: string, name: string): Promise<GitResult<void>>;

  log(rootPath: string, opts?: GitLogOptions): Promise<GitResult<GitLogEntry[]>>;
  /** Files changed in one commit plus the full message body. */
  commitFiles(
    rootPath: string,
    sha: string,
  ): Promise<GitResult<{ body: string; files: GitFileChange[] }>>;
  readFileAtRevision(
    rootPath: string,
    path: string,
    revision: GitRevision,
  ): Promise<GitResult<GitFileAtRevision>>;

  listRemotes(rootPath: string): Promise<GitResult<GitRemoteInfo[]>>;

  /**
   * Clone a remote repository. The main process shows a native picker for the
   * destination parent directory, then registers the clone as a workspace.
   */
  clone(url: string, onProgress?: (p: GitCloneProgress) => void): GitCloneHandle;

  /** `gh pr create --web` (falls back to `gh pr view --web` if one exists). */
  createPullRequest(rootPath: string): Promise<GitResult<void>>;

  /**
   * Throttled status stream for a workspace root. Emits once immediately on
   * subscribe. Returns an unsubscribe function.
   */
  onStatusChanged(rootPath: string, listener: (status: GitStatus) => void): () => void;
}
