/**
 * Git host API — wire types for the desktop shell's git integration.
 *
 * The desktop app spawns the user's system git from the main process, so
 * credentials (helpers, SSH agent, signing config and raw remote URLs) remain
 * in the main process. Everything here is generic git; the only host-specific
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
  | 'permission-denied'
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
  /** False when the workspace root is a subdirectory of a larger repo. */
  rootIsToplevel?: boolean;
  /** Main-owned repository authority; absent while expanded access is ungranted. */
  repositoryId?: string;
  /** True when Git metadata or the work tree extends beyond the workspace grant. */
  requiresExpandedGrant?: boolean;
  /**
   * Display path of the enclosing repository root. Present only alongside
   * `requiresExpandedGrant` so the in-app consent surface can name what the
   * user would be granting access to.
   */
  repositoryRoot?: string;
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
  /** Sanitized web location. Raw fetch/push URLs never cross IPC. */
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
  /**
   * Detect a persisted workspace by opaque workspace id and mint repository
   * authority. Never prompts: a workspace inside a larger repository comes
   * back with `requiresExpandedGrant` and no `repositoryId` until the user
   * opts in through `grantExpandedRepo`.
   */
  detectRepo(workspaceId: string): Promise<GitResult<GitRepoDetection>>;
  /**
   * Grant expanded access to the repository enclosing the workspace and mint
   * repository authority. Must be called from an explicit user gesture. The
   * choice is remembered for that repository; `always` remembers it for every
   * repository opened from a subfolder.
   */
  grantExpandedRepo(
    workspaceId: string,
    opts?: { always?: boolean },
  ): Promise<GitResult<GitRepoDetection>>;
  init(workspaceId: string): Promise<GitResult<void>>;

  status(repositoryId: string): Promise<GitResult<GitStatus>>;
  stage(repositoryId: string, paths: string[]): Promise<GitResult<void>>;
  unstage(repositoryId: string, paths: string[]): Promise<GitResult<void>>;
  /** Revert tracked files to HEAD; delete untracked ones. Destructive — the renderer confirms. */
  discard(repositoryId: string, paths: string[]): Promise<GitResult<void>>;
  /**
   * With `paths`: stages exactly those files (`add -A -- <paths>`) and commits
   * them, leaving other staged entries staged. Without: commits the index as-is.
   */
  commit(
    repositoryId: string,
    message: string,
    paths?: string[],
  ): Promise<GitResult<{ sha: string }>>;

  push(repositoryId: string, opts?: { setUpstream?: boolean }): Promise<GitResult<void>>;
  pull(repositoryId: string): Promise<GitResult<void>>;
  fetch(repositoryId: string): Promise<GitResult<void>>;

  listBranches(repositoryId: string): Promise<GitResult<GitBranchInfo[]>>;
  createBranch(
    repositoryId: string,
    name: string,
    opts?: { checkout?: boolean },
  ): Promise<GitResult<void>>;
  checkoutBranch(repositoryId: string, name: string): Promise<GitResult<void>>;

  log(repositoryId: string, opts?: GitLogOptions): Promise<GitResult<GitLogEntry[]>>;
  /** Files changed in one commit plus the full message body. */
  commitFiles(
    repositoryId: string,
    sha: string,
  ): Promise<GitResult<{ body: string; files: GitFileChange[] }>>;
  readFileAtRevision(
    repositoryId: string,
    path: string,
    revision: GitRevision,
  ): Promise<GitResult<GitFileAtRevision>>;

  listRemotes(repositoryId: string): Promise<GitResult<GitRemoteInfo[]>>;

  /**
   * Clone a remote repository. The main process shows a native picker for the
   * destination parent directory, then registers the clone as a workspace.
   */
  clone(url: string, onProgress?: (p: GitCloneProgress) => void): GitCloneHandle;

  /** `gh pr create --web` (falls back to `gh pr view --web` if one exists). */
  createPullRequest(repositoryId: string): Promise<GitResult<void>>;

  /**
   * Throttled status stream for a workspace root. Emits once immediately on
   * subscribe. Returns an unsubscribe function.
   */
  onStatusChanged(repositoryId: string, listener: (status: GitStatus) => void): () => void;
}
