/**
 * useGit — the single hook DocBlocksShell calls to power all git UI.
 *
 * Tier 1 (`available`): running under the Electron host with a working git —
 * gates only the clone entry. Tier 2 (`repo`): the active workspace is an
 * electron-native folder that is a git repository — gates everything else.
 * On the site / VS Code webview / store builds every surface null-renders.
 *
 * Actions never throw: typed GitErrors are routed to the auth-guidance or
 * conflicts dialogs when actionable, otherwise to the aria-live result line.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DocBlocksHostGitAPI,
  GitCapabilities,
  GitError,
  GitRepoDetection,
  GitRemoteInfo,
} from '@bendyline/docblocks/host';
import { maybeGetDocBlocksHost } from '@bendyline/docblocks/host';
import type { FileSystemProvider } from '@bendyline/docblocks/filesystem';
import { buildBadgeMap, conflictedPaths } from './git-status.js';
import { useGitStatus } from './useGitStatus.js';
import type { GitBusyKind, GitDialogState, GitInlineResult, GitValue } from './GitContext.js';

/**
 * Capabilities can't change within a session — probe once per page load.
 *
 * Only a *fulfilled* probe is cached. Caching the rejected promise meant a
 * single transient IPC failure pinned `available` to false for the life of
 * the page, hiding every git surface with no way back short of a reload.
 */
let capabilitiesPromise: Promise<GitCapabilities> | null = null;
function capabilitiesOnce(gitApi: DocBlocksHostGitAPI): Promise<GitCapabilities> {
  capabilitiesPromise ??= gitApi.capabilities().catch((error: unknown) => {
    capabilitiesPromise = null;
    throw error;
  });
  return capabilitiesPromise;
}

/** Test seam — drops the memoised probe so each test starts clean. */
export function resetGitCapabilitiesCache(): void {
  capabilitiesPromise = null;
}

/** Bounded retry for the capabilities probe — a transient IPC failure
    must not permanently hide the git UI. */
const CAPABILITIES_RETRIES = 2;
const CAPABILITIES_RETRY_MS = 1000;

function describeError(error: GitError): string {
  return error.message || 'Git operation failed';
}

export function useGit(
  provider: FileSystemProvider | null,
  requestedWorkspaceId: string | null,
  theme: 'light' | 'dark',
): GitValue {
  const host = maybeGetDocBlocksHost();
  const gitApi = host?.git ?? null;
  const workspaceId = gitApi ? requestedWorkspaceId : null;

  const [capabilities, setCapabilities] = useState<GitCapabilities | null>(null);
  useEffect(() => {
    if (!gitApi) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // `available` gates every git surface, so a probe that fails must be
    // retried rather than silently leaving the UI switched off.
    const attempt = (remaining: number) => {
      void capabilitiesOnce(gitApi).then(
        (caps) => {
          if (!cancelled) setCapabilities(caps);
        },
        (error: unknown) => {
          if (cancelled) return;
          if (remaining > 0) {
            timer = setTimeout(() => attempt(remaining - 1), CAPABILITIES_RETRY_MS);
            return;
          }
          console.warn('DocBlocks: git capabilities probe failed; git UI stays hidden', error);
        },
      );
    };
    attempt(CAPABILITIES_RETRIES);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [gitApi]);

  const available = gitApi !== null && capabilities?.gitAvailable === true;

  const [repo, setRepo] = useState<GitRepoDetection | null>(null);
  const [remoteWeb, setRemoteWeb] = useState<GitValue['remoteWeb']>(null);
  useEffect(() => {
    setRepo(null);
    setRemoteWeb(null);
    if (!gitApi || !workspaceId || !available) return;
    let cancelled = false;
    void gitApi.detectRepo(workspaceId).then(
      (result) => {
        if (cancelled || !result.ok || !result.value.isRepo || !result.value.repositoryId) {
          return;
        }
        setRepo(result.value);
        void gitApi.listRemotes(result.value.repositoryId).then(
          (remotes) => {
            if (cancelled || !remotes.ok) return;
            const first: GitRemoteInfo | undefined = remotes.value[0];
            setRemoteWeb(first?.web ?? null);
          },
          // No remote is a supported state; a failed probe degrades to it
          // rather than surfacing an unhandled rejection.
          () => undefined,
        );
      },
      /* detection failure → not a repo, which is the default state */ () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [gitApi, workspaceId, available]);

  const repositoryId = repo?.repositoryId ?? null;
  const isRepo = repositoryId !== null;
  const { status, refresh, scheduleRefresh } = useGitStatus(gitApi, repositoryId, isRepo);
  const badges = useMemo(() => buildBadgeMap(status?.changes ?? []), [status]);

  const [busy, setBusy] = useState<GitBusyKind>(null);
  const [lastResult, setLastResult] = useState<GitInlineResult | null>(null);
  const [dialog, setDialog] = useState<GitDialogState>({ kind: 'none' });

  const openDialog = useCallback((next: GitDialogState) => {
    // `lastResult` is a single shared slot rendered as a role="alert" by
    // whichever dialog is open. Without this, yesterday's failed pull
    // greets the user inside today's commit dialog. Operations that open a
    // dialog *to report* an outcome (routeError, the conflicts dialog) set
    // the dialog directly and are unaffected.
    setLastResult(null);
    setDialog(next);
  }, []);
  const closeDialog = useCallback(() => setDialog({ kind: 'none' }), []);

  // Route a failed operation somewhere useful.
  const routeError = useCallback(
    (operation: 'push' | 'pull' | 'fetch' | 'commit' | 'branch' | 'pr', error: GitError) => {
      if (error.code === 'auth-failed') {
        setDialog({
          kind: 'auth-guidance',
          operation: operation === 'commit' || operation === 'branch' ? 'push' : operation,
          detail: error.message,
        });
        return;
      }
      setLastResult({ tone: 'error', message: describeError(error) });
    },
    [],
  );

  // Mirrored in an effect, not during render: a render-phase ref write is
  // impure and can be torn by a discarded concurrent render. Only the
  // action callbacks read it, and they run after commit.
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const runAction = useCallback(
    async <T>(
      kind: Exclude<GitBusyKind, null>,
      operation: 'push' | 'pull' | 'fetch' | 'commit' | 'branch' | 'pr',
      action: (
        api: DocBlocksHostGitAPI,
        repository: string,
      ) => Promise<{ ok: true; value: T } | { ok: false; error: GitError }>,
      successMessage?: string,
    ): Promise<boolean> => {
      if (!gitApi || !repositoryId) return false;
      setBusy(kind);
      setLastResult(null);
      try {
        const result = await action(gitApi, repositoryId);
        if (result.ok) {
          if (successMessage) setLastResult({ tone: 'info', message: successMessage });
          refresh();
          return true;
        }
        if (operation === 'pull' && result.error.code === 'merge-conflict') {
          // Surface the conflicted files; the fresh status carries them.
          const fresh = await gitApi.status(repositoryId);
          const paths = fresh.ok ? conflictedPaths(fresh.value) : [];
          refresh();
          setDialog({ kind: 'conflicts', paths });
          setLastResult({ tone: 'error', message: 'Pull hit merge conflicts' });
          return false;
        }
        routeError(operation, result.error);
        refresh();
        return false;
      } finally {
        setBusy(null);
      }
    },
    [gitApi, repositoryId, refresh, routeError],
  );

  const commit = useCallback(
    (message: string, paths: string[]) =>
      runAction(
        'commit',
        'commit',
        (api, repository) => api.commit(repository, message, paths),
        'Committed',
      ),
    [runAction],
  );

  const push = useCallback(async () => {
    const setUpstream = statusRef.current?.upstream === null;
    await runAction(
      'push',
      'push',
      (api, repository) => api.push(repository, setUpstream ? { setUpstream: true } : undefined),
      setUpstream ? 'Branch published' : 'Pushed',
    );
  }, [runAction]);

  const pull = useCallback(async () => {
    await runAction('pull', 'pull', (api, repository) => api.pull(repository), 'Pulled');
  }, [runAction]);

  const fetchRemote = useCallback(async () => {
    await runAction('fetch', 'fetch', (api, repository) => api.fetch(repository), 'Fetched');
  }, [runAction]);

  const createBranch = useCallback(
    (name: string) =>
      runAction(
        'branch',
        'branch',
        (api, repository) => api.createBranch(repository, name, { checkout: true }),
        `Switched to new branch ${name}`,
      ),
    [runAction],
  );

  const switchBranch = useCallback(
    (name: string) =>
      runAction(
        'branch',
        'branch',
        (api, repository) => api.checkoutBranch(repository, name),
        `Switched to ${name}`,
      ),
    [runAction],
  );

  const openOnRemote = useCallback(
    (filePath?: string) => {
      if (!remoteWeb || !host) return;
      let url = remoteWeb.webUrl;
      // Only GitHub's blob-path shape is a safe bet; other hosts get the repo.
      if (filePath && remoteWeb.host === 'github.com' && statusRef.current?.branch) {
        const rel = filePath.replace(/^\/+/, '');
        url = `${remoteWeb.webUrl}/blob/${encodeURIComponent(statusRef.current.branch)}/${rel
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`;
      }
      void host.shell.openExternal(url);
    },
    [remoteWeb, host],
  );

  const createPullRequest = useCallback(async () => {
    if (!gitApi || !repositoryId) return;
    setBusy('pr');
    setLastResult(null);
    try {
      const result = await gitApi.createPullRequest(repositoryId);
      if (result.ok) {
        setLastResult({ tone: 'info', message: 'Opening pull request in browser' });
        return;
      }
      if (result.error.code === 'no-upstream') {
        setLastResult({
          tone: 'error',
          message: 'Push the branch first, then create the pull request',
        });
        return;
      }
      if (result.error.code === 'gh-not-available') {
        setLastResult({
          tone: 'error',
          message: 'Install the GitHub CLI (gh) to create pull requests',
        });
        return;
      }
      routeError('pr', result.error);
    } finally {
      setBusy(null);
    }
  }, [gitApi, repositoryId, routeError]);

  // This object *is* the GitContext.Provider value (DocBlocksShell passes it
  // straight through). Rebuilding it every render re-rendered the status
  // bar, toolbar, tree badges and any open dialog on every shell render,
  // which also negated useGitStatus's payload dedupe.
  return useMemo(
    () => ({
      available,
      capabilities,
      repo,
      repositoryId,
      remoteWeb,
      gitApi,
      provider,
      theme,
      status,
      badges,
      busy,
      lastResult,
      refresh,
      scheduleRefresh,
      commit,
      push,
      pull,
      fetchRemote,
      createBranch,
      switchBranch,
      openOnRemote,
      createPullRequest,
      dialog,
      openDialog,
      closeDialog,
    }),
    [
      available,
      capabilities,
      repo,
      repositoryId,
      remoteWeb,
      gitApi,
      provider,
      theme,
      status,
      badges,
      busy,
      lastResult,
      refresh,
      scheduleRefresh,
      commit,
      push,
      pull,
      fetchRemote,
      createBranch,
      switchBranch,
      openOnRemote,
      createPullRequest,
      dialog,
      openDialog,
      closeDialog,
    ],
  );
}
