/**
 * GitContext — the seam between DocBlocksShell and every git UI surface.
 *
 * The shell calls useGit() once and provides the value here; the status
 * bar, file-tree badges, toolbar control, and dialogs all consume it.
 * Consumers must tolerate a null context (FileExplorer renders standalone
 * in tests and on surfaces with no git).
 */

import { createContext, useContext } from 'react';
import type {
  DocBlocksHostGitAPI,
  GitCapabilities,
  GitRepoDetection,
  GitStatus,
} from '@bendyline/docblocks/host';
import type { FileSystemProvider } from '@bendyline/docblocks/filesystem';
import type { GitBadgeKind } from './git-status.js';

export type GitDialogState =
  | { kind: 'none' }
  | { kind: 'commit' }
  | { kind: 'branches'; createFocus?: boolean }
  | { kind: 'history'; path?: string }
  /** `revision` absent → working tree vs HEAD; present → that commit vs its parent. */
  | { kind: 'diff'; path: string; revision?: { sha: string } }
  | { kind: 'clone' }
  /** Offer to allow git operations on the repository above the workspace. */
  | { kind: 'expanded-grant' }
  | {
      kind: 'auth-guidance';
      operation: 'push' | 'pull' | 'fetch' | 'clone' | 'pr';
      detail?: string;
    }
  | { kind: 'conflicts'; paths: string[] };

export type GitBusyKind = 'push' | 'pull' | 'fetch' | 'commit' | 'branch' | 'pr' | null;

export interface GitInlineResult {
  tone: 'info' | 'error';
  message: string;
}

export interface GitValue {
  /** Tier 1 — Electron host with a working git. Gates the clone entry. */
  available: boolean;
  capabilities: GitCapabilities | null;
  /** Tier 2 — the active workspace root is a repository. Gates everything else. */
  repo: GitRepoDetection | null;
  /** Main-owned repository capability; never a native path. */
  repositoryId: string | null;
  /**
   * Set when the workspace is inside a larger repository the user hasn't
   * allowed git to touch yet. Git stays off (`repo` is null) until
   * `enableExpandedRepo` succeeds; the status bar offers the switch.
   */
  pendingGrant: { repositoryRoot: string | null } | null;
  /** A grant request is in flight. */
  grantBusy: boolean;
  /**
   * Allow git to operate on the enclosing repository. Remembers the choice
   * for that repository, or for every repository with `always`. Must be
   * called from an explicit user gesture.
   */
  enableExpandedRepo: (opts?: { always?: boolean }) => Promise<boolean>;
  /** Parsed web location of the first remote, when one exists and parses. */
  remoteWeb: { host: string; owner: string; repo: string; webUrl: string } | null;
  /** Raw host API for read-heavy dialogs (log, branches, file-at-revision). */
  gitApi: DocBlocksHostGitAPI | null;
  provider: FileSystemProvider | null;
  theme: 'light' | 'dark';

  status: GitStatus | null;
  badges: ReadonlyMap<string, GitBadgeKind>;
  busy: GitBusyKind;
  /** Latest operation outcome, surfaced in an aria-live region. */
  lastResult: GitInlineResult | null;

  refresh: () => void;
  /** Debounced refresh — used after autosave writes. */
  scheduleRefresh: () => void;

  /** Actions route their typed errors to dialogs/lastResult internally. */
  commit: (message: string, paths: string[]) => Promise<boolean>;
  push: () => Promise<void>;
  pull: () => Promise<void>;
  fetchRemote: () => Promise<void>;
  createBranch: (name: string) => Promise<boolean>;
  switchBranch: (name: string) => Promise<boolean>;
  /** Open the repo (or a file within it) on the remote's web host. */
  openOnRemote: (filePath?: string) => void;
  createPullRequest: () => Promise<void>;

  dialog: GitDialogState;
  openDialog: (dialog: GitDialogState) => void;
  closeDialog: () => void;
}

export const GitContext = createContext<GitValue | null>(null);

/** Null when no provider is mounted — callers must degrade gracefully. */
export function useGitContext(): GitValue | null {
  return useContext(GitContext);
}
