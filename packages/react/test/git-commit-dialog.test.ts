/**
 * GitCommitDialog — the commit list must always commit exactly what its
 * checkboxes show, including files git only reports after the dialog
 * opened (autosave triggers a status refresh every 1.5s while it is open).
 */
import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { GitFileChange, GitStatus } from '@bendyline/docblocks/host';
import { GitContext, type GitValue } from '../src/Git/GitContext.js';
import { GitCommitDialog } from '../src/Git/GitCommitDialog.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
// Supply the classic JSX runtime expected by its direct source transform.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

function change(path: string, conflicted = false): GitFileChange {
  return { path, worktree: 'modified', conflicted };
}

function statusWith(changes: GitFileChange[], operation: GitStatus['operation'] = null): GitStatus {
  return {
    branch: 'main',
    detached: false,
    unborn: false,
    head: 'abc123',
    upstream: null,
    ahead: 0,
    behind: 0,
    changes,
    truncated: false,
    operation,
  };
}

function gitValue(status: GitStatus, commit: GitValue['commit']): GitValue {
  return {
    available: true,
    capabilities: null,
    repo: { isRepo: true },
    repositoryId: 'repo-1',
    remoteWeb: null,
    gitApi: null,
    provider: null,
    theme: 'light',
    status,
    badges: new Map(),
    busy: null,
    lastResult: null,
    refresh: () => undefined,
    scheduleRefresh: () => undefined,
    commit,
    push: async () => undefined,
    pull: async () => undefined,
    fetchRemote: async () => undefined,
    createBranch: async () => false,
    switchBranch: async () => false,
    openOnRemote: () => undefined,
    createPullRequest: async () => undefined,
    dialog: { kind: 'commit' },
    openDialog: () => undefined,
    closeDialog: () => undefined,
  };
}

/** Write through the prototype setter so React's value tracker sees a change. */
function typeInto(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element) as object,
    'value',
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function rowFor(container: HTMLElement, path: string): HTMLInputElement {
  const label = path.replace(/^\/+/, '');
  const row = [...container.querySelectorAll<HTMLLIElement>('.db-git-file-row')].find(
    (candidate) => candidate.querySelector('span')?.textContent === label,
  );
  const checkbox = row?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!checkbox) throw new Error(`No commit row rendered for ${path}`);
  return checkbox;
}

describe('GitCommitDialog', () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let committed: { message: string; paths: string[] } | null;
  let commit: GitValue['commit'];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    committed = null;
    commit = async (message: string, paths: string[]) => {
      committed = { message, paths };
      return true;
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  /** Mount with `initial` changes, then refresh status to `next`. */
  async function renderWithLateChange(
    initial: GitFileChange[],
    next: GitFileChange[],
  ): Promise<void> {
    const render = (changes: GitFileChange[]) =>
      root.render(
        createElement(
          GitContext.Provider,
          { value: gitValue(statusWith(changes), commit) },
          createElement(GitCommitDialog, { onClose: () => undefined }),
        ),
      );

    await act(async () => render(initial));
    // The refresh that lands while the dialog is open.
    await act(async () => render(next));
  }

  it('commits a file that git reported after the dialog opened', async () => {
    await renderWithLateChange([change('/a.md')], [change('/a.md'), change('/late.md')]);

    // The row renders checked...
    expect(rowFor(container, '/late.md').checked).to.equal(true);

    const message = container.querySelector<HTMLTextAreaElement>('textarea');
    expect(message).not.to.equal(null);
    await act(async () => typeInto(message!, 'fix: thing'));

    const commitButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Commit',
    );
    expect(commitButton?.disabled).to.equal(false);
    await act(async () => commitButton!.click());

    // ...so it must be in the commit.
    expect(committed).not.to.equal(null);
    expect(committed?.paths).to.deep.equal(['/a.md', '/late.md']);
  });

  it('excludes a file that appeared after the dialog opened in one click', async () => {
    await renderWithLateChange([change('/a.md')], [change('/a.md'), change('/late.md')]);

    const late = rowFor(container, '/late.md');
    expect(late.checked).to.equal(true);
    await act(async () => late.click());
    expect(rowFor(container, '/late.md').checked).to.equal(false);

    const message = container.querySelector<HTMLTextAreaElement>('textarea');
    await act(async () => typeInto(message!, 'fix: thing'));
    const commitButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Commit',
    );
    await act(async () => commitButton!.click());

    expect(committed?.paths).to.deep.equal(['/a.md']);
  });

  it('keeps an exclusion across a status refresh that adds a file', async () => {
    const render = (changes: GitFileChange[]) =>
      root.render(
        createElement(
          GitContext.Provider,
          { value: gitValue(statusWith(changes), commit) },
          createElement(GitCommitDialog, { onClose: () => undefined }),
        ),
      );

    await act(async () => render([change('/a.md'), change('/b.md')]));
    await act(async () => rowFor(container, '/a.md').click());
    await act(async () => render([change('/a.md'), change('/b.md'), change('/late.md')]));

    expect(rowFor(container, '/a.md').checked).to.equal(false);
    expect(rowFor(container, '/late.md').checked).to.equal(true);

    const message = container.querySelector<HTMLTextAreaElement>('textarea');
    await act(async () => typeInto(message!, 'fix: thing'));
    const commitButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Commit',
    );
    await act(async () => commitButton!.click());

    expect(committed?.paths).to.deep.equal(['/b.md', '/late.md']);
  });

  describe('while git has an operation in progress', () => {
    /** Mount the dialog against a status carrying `operation`. */
    async function renderDuring(
      operation: GitStatus['operation'],
      changes: GitFileChange[],
    ): Promise<void> {
      await act(async () =>
        root.render(
          createElement(
            GitContext.Provider,
            { value: gitValue(statusWith(changes, operation), commit) },
            createElement(GitCommitDialog, { onClose: () => undefined }),
          ),
        ),
      );
    }

    it('locks a non-conflicted row during a merge instead of letting it lie', async () => {
      // Regression (SF-3): the host drops the pathspec mid-merge and
      // commits the whole index, but only conflicted rows were disabled.
      // A live checkbox on /a.md promised an exclusion that never happened.
      await renderDuring('merge', [change('/a.md'), change('/conflict.md', true)]);

      const plain = rowFor(container, '/a.md');
      expect(plain.checked).to.equal(true);
      expect(
        plain.disabled,
        'a non-conflicted row must not offer a choice it cannot honour',
      ).to.equal(true);
      expect(rowFor(container, '/conflict.md').disabled).to.equal(true);
    });

    it('commits a non-conflicted file during a merge even after a click at it', async () => {
      await renderDuring('merge', [change('/a.md'), change('/conflict.md', true)]);

      // A disabled input ignores clicks, so this asserts the *outcome*:
      // what the dialog shows is what gets committed.
      await act(async () => rowFor(container, '/a.md').click());
      expect(rowFor(container, '/a.md').checked).to.equal(true);

      const message = container.querySelector<HTMLTextAreaElement>('textarea');
      await act(async () => typeInto(message!, 'merge: resolve'));
      const commitButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === 'Commit',
      );
      await act(async () => commitButton!.click());

      expect(committed?.paths).to.deep.equal(['/a.md', '/conflict.md']);
    });

    it('explains why nothing can be excluded, and hides the dead bulk toggle', async () => {
      await renderDuring('merge', [change('/a.md')]);

      expect(container.textContent).to.include('cannot be left out');
      const bulk = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        ['Select all', 'Select none'].includes(button.textContent?.trim() ?? ''),
      );
      expect(bulk, 'a bulk toggle that cannot change anything must not render').to.equal(undefined);
    });

    it('locks rows during a cherry-pick too — the pathspec is dropped the same way', async () => {
      // isMergeCommit() only covered 'merge', so a cherry-pick left every
      // checkbox interactive while the host still ignored them.
      await renderDuring('cherry-pick', [change('/a.md')]);
      expect(rowFor(container, '/a.md').disabled).to.equal(true);
    });

    it('leaves rows interactive when no operation is in progress', async () => {
      await renderDuring(null, [change('/a.md')]);
      expect(rowFor(container, '/a.md').disabled).to.equal(false);
    });
  });

  it('drops a file from the commit once git stops reporting it', async () => {
    await renderWithLateChange([change('/a.md'), change('/gone.md')], [change('/a.md')]);

    expect(container.textContent).to.not.include('gone.md');

    const message = container.querySelector<HTMLTextAreaElement>('textarea');
    await act(async () => typeInto(message!, 'fix: thing'));
    const commitButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Commit',
    );
    await act(async () => commitButton!.click());

    expect(committed?.paths).to.deep.equal(['/a.md']);
  });
});
