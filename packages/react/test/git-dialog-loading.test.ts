/**
 * Git read-only dialogs must never strand the user on a spinner.
 *
 * Both dialogs load from the host with a bare `.then()`. When the IPC
 * *rejects* (rather than returning an `ok:false` result) there was no
 * rejection handler at all, so the dialog sat on "Loading…" for as long as
 * it stayed open — and the rejection surfaced as an unhandled promise.
 *
 * GitHistoryDialog additionally had no cancellation, so a slow page from a
 * previous repo/file could append the wrong repository's commits.
 */
import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { DocBlocksHostGitAPI, GitLogEntry, GitStatus } from '@bendyline/docblocks/host';
import { GitContext, type GitValue } from '../src/Git/GitContext.js';
import { GitBranchesDialog } from '../src/Git/GitBranchesDialog.js';
import { GitHistoryDialog } from '../src/Git/GitHistoryDialog.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
// Supply the classic JSX runtime expected by its direct source transform.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

function makeStatus(): GitStatus {
  return {
    branch: 'main',
    detached: false,
    unborn: false,
    head: 'abc123',
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: [],
    truncated: false,
    operation: null,
  };
}

function logEntry(sha: string, subject: string): GitLogEntry {
  return {
    sha,
    subject,
    body: subject,
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authorDate: '2024-01-01T00:00:00Z',
    refs: [],
  } as unknown as GitLogEntry;
}

function gitValue(gitApi: DocBlocksHostGitAPI, repositoryId: string): GitValue {
  return {
    available: true,
    capabilities: null,
    repo: { isRepo: true },
    repositoryId,
    remoteWeb: null,
    gitApi,
    provider: null,
    theme: 'light',
    status: makeStatus(),
    badges: new Map(),
    busy: null,
    lastResult: null,
    refresh: () => undefined,
    scheduleRefresh: () => undefined,
    commit: async () => true,
    push: async () => undefined,
    pull: async () => undefined,
    fetchRemote: async () => undefined,
    createBranch: async () => false,
    switchBranch: async () => false,
    openOnRemote: () => undefined,
    createPullRequest: async () => undefined,
    dialog: { kind: 'none' },
    openDialog: () => undefined,
    closeDialog: () => undefined,
  } as unknown as GitValue;
}

/** Let queued microtasks/rejection handlers settle inside act(). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

describe('git dialogs — failed loads', () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let unhandled: unknown[];
  let onUnhandled: (reason: unknown) => void;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    unhandled = [];
    onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(async () => {
    process.off('unhandledRejection', onUnhandled);
    await act(async () => root.unmount());
    container.remove();
  });

  describe('GitBranchesDialog', () => {
    it('shows the failure instead of loading forever when listBranches rejects', async () => {
      const gitApi = {
        listBranches: () => Promise.reject(new Error('Host channel closed')),
      } as unknown as DocBlocksHostGitAPI;

      await act(async () =>
        root.render(
          createElement(
            GitContext.Provider,
            { value: gitValue(gitApi, 'repo-1') },
            createElement(GitBranchesDialog, { onClose: () => undefined }),
          ),
        ),
      );
      await settle();

      expect(container.textContent, 'the dialog must not sit on a spinner').to.not.include(
        'Loading branches…',
      );
      const alert = container.querySelector('[role="alert"]');
      expect(alert, 'a rejected load must be surfaced').to.not.equal(null);
      expect(alert?.textContent).to.include('Host channel closed');
      expect(unhandled, 'the rejection must be handled').to.deep.equal([]);
    });

    it('still renders branches on a successful load', async () => {
      const gitApi = {
        listBranches: () =>
          Promise.resolve({
            ok: true,
            value: [{ name: 'main', kind: 'local', current: true }],
          }),
      } as unknown as DocBlocksHostGitAPI;

      await act(async () =>
        root.render(
          createElement(
            GitContext.Provider,
            { value: gitValue(gitApi, 'repo-1') },
            createElement(GitBranchesDialog, { onClose: () => undefined }),
          ),
        ),
      );
      await settle();

      expect(container.textContent).to.include('main');
      expect(container.querySelector('[role="alert"]')).to.equal(null);
    });
  });

  describe('GitHistoryDialog', () => {
    it('shows the failure instead of claiming there are no commits when log rejects', async () => {
      const gitApi = {
        log: () => Promise.reject(new Error('Host channel closed')),
        commitFiles: () => Promise.resolve({ ok: true, value: { body: '', files: [] } }),
      } as unknown as DocBlocksHostGitAPI;

      await act(async () =>
        root.render(
          createElement(
            GitContext.Provider,
            { value: gitValue(gitApi, 'repo-1') },
            createElement(GitHistoryDialog, { onClose: () => undefined }),
          ),
        ),
      );
      await settle();

      const alert = container.querySelector('[role="alert"]');
      expect(alert, 'a rejected log must be surfaced').to.not.equal(null);
      expect(alert?.textContent).to.include('Host channel closed');
      expect(container.textContent).to.not.include('No commits yet');
      expect(unhandled, 'the rejection must be handled').to.deep.equal([]);
    });

    it('surfaces a rejected commitFiles instead of a permanent row spinner', async () => {
      const gitApi = {
        log: () => Promise.resolve({ ok: true, value: [logEntry('aaa1111', 'First commit')] }),
        commitFiles: () => Promise.reject(new Error('Commit read failed')),
      } as unknown as DocBlocksHostGitAPI;

      await act(async () =>
        root.render(
          createElement(
            GitContext.Provider,
            { value: gitValue(gitApi, 'repo-1') },
            createElement(GitHistoryDialog, { onClose: () => undefined }),
          ),
        ),
      );
      await settle();

      const toggle = container.querySelector<HTMLButtonElement>('.db-git-history-toggle');
      expect(toggle, 'the commit row should render').to.not.equal(null);
      await act(async () => toggle!.click());
      await settle();

      expect(container.textContent, 'the expanded row must not spin forever').to.not.include(
        'Loading…',
      );
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).to.include('Commit read failed');
      expect(unhandled, 'the rejection must be handled').to.deep.equal([]);
    });

    it('does not append a slow page from the repository it was showing before', async () => {
      // Regression: loadPage had no cancellation, so a log resolving after
      // the dialog retargeted appended the *old* repo's commits.
      let releaseFirst: ((value: unknown) => void) | null = null;
      const gitApi = {
        log: (repositoryId: string) => {
          if (repositoryId === 'repo-old') {
            return new Promise((resolve) => {
              releaseFirst = resolve;
            });
          }
          return Promise.resolve({ ok: true, value: [logEntry('bbb2222', 'New repo commit')] });
        },
        commitFiles: () => Promise.resolve({ ok: true, value: { body: '', files: [] } }),
      } as unknown as DocBlocksHostGitAPI;

      const render = (repositoryId: string) =>
        root.render(
          createElement(
            GitContext.Provider,
            { value: gitValue(gitApi, repositoryId) },
            createElement(GitHistoryDialog, { onClose: () => undefined }),
          ),
        );

      await act(async () => render('repo-old'));
      // The user switches repository while the first log is still in flight.
      await act(async () => render('repo-new'));
      await settle();
      expect(container.textContent).to.include('New repo commit');

      // The old repo's page finally lands.
      await act(async () => {
        releaseFirst?.({ ok: true, value: [logEntry('ccc3333', 'Old repo commit')] });
      });
      await settle();

      expect(
        container.textContent,
        "the previous repository's commits must not appear",
      ).to.not.include('Old repo commit');
      expect(container.textContent).to.include('New repo commit');
    });
  });
});
