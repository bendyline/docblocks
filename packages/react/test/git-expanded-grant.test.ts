/**
 * Opening a folder inside a larger repository must not interrupt the user.
 *
 * The native "Allow access to the full Git repository?" message box fired on
 * every such folder open, before the user had asked for anything git-related.
 * Git now stays off and the offer lives quietly at the foot of the sidebar,
 * opening a dialog whose answer is remembered by the host.
 */
import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { GitContext, type GitDialogState, type GitValue } from '../src/Git/GitContext.js';
import { GitStatusBar } from '../src/Git/GitStatusBar.js';
import { GitGrantNotice } from '../src/Git/GitGrantNotice.js';
import { GitExpandedGrantDialog } from '../src/Git/GitExpandedGrantDialog.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

function gitValue(overrides: Partial<GitValue> = {}): GitValue {
  return {
    available: true,
    capabilities: null,
    repo: null,
    repositoryId: null,
    pendingGrant: { repositoryRoot: 'D:/gh/molen-internal' },
    grantBusy: false,
    enableExpandedRepo: async () => true,
    remoteWeb: null,
    gitApi: null,
    provider: null,
    theme: 'light',
    status: null,
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
    ...overrides,
  } as unknown as GitValue;
}

describe('expanded git grant offer', () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(value: GitValue, node: React.ReactElement): Promise<void> {
    await act(async () => root.render(createElement(GitContext.Provider, { value }, node)));
  }

  it('offers the grant without an alarm, and names the repository', async () => {
    const opened: GitDialogState[] = [];
    const value = gitValue({ openDialog: (dialog) => opened.push(dialog) });
    await render(value, createElement(GitGrantNotice));

    const action = container.querySelector<HTMLButtonElement>('.db-git-grant-notice-action');
    expect(action, 'a blocked repo must surface the offer').to.not.equal(null);
    expect(action?.getAttribute('aria-label')).to.include('D:/gh/molen-internal');
    // Nothing here may read as a fault: no warning glyph, no bold text.
    expect(container.textContent).to.not.include('⚠');
    expect(container.querySelector('strong, b')).to.equal(null);

    await act(async () => action?.click());
    expect(opened).to.deep.equal([{ kind: 'expanded-grant' }]);
  });

  it('keeps the offer out of the status bar, which speaks only for a usable repo', async () => {
    await render(gitValue(), createElement(GitStatusBar));
    expect(container.textContent).to.equal('');
  });

  it('renders nothing once no grant is pending and no repo is usable', async () => {
    await render(gitValue({ pendingGrant: null }), createElement(GitGrantNotice));
    expect(container.textContent).to.equal('');
  });

  it('remembers the always-enable choice the user checked', async () => {
    const calls: ({ always?: boolean } | undefined)[] = [];
    let closed = 0;
    const value = gitValue({
      enableExpandedRepo: async (opts) => {
        calls.push(opts);
        return true;
      },
    });
    await render(value, createElement(GitExpandedGrantDialog, { onClose: () => (closed += 1) }));

    const checkbox = container.querySelector<HTMLInputElement>('.db-git-grant-remember input');
    expect(checkbox, 'the remember-for-all choice must be offered').to.not.equal(null);
    await act(async () => checkbox?.click());

    const enable = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Enable Git',
    );
    await act(async () => enable?.click());

    expect(calls).to.deep.equal([{ always: true }]);
    expect(closed, 'the dialog closes once the grant resolves').to.equal(1);
  });
});
