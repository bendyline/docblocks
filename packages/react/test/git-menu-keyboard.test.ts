/**
 * The git dropdowns must honour the WAI-ARIA menu-button key contract
 * (SF-5). They advertised `role="menu"` while handling no keys at all: no
 * Escape, no arrows, and no focus management — so a keyboard user could
 * open a menu and then be stranded in it.
 */
import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { GitStatus } from '@bendyline/docblocks/host';
import { GitContext, type GitValue } from '../src/Git/GitContext.js';
import { GitStatusBar } from '../src/Git/GitStatusBar.js';
import { GitToolbarControl } from '../src/Git/GitToolbarControl.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
// Supply the classic JSX runtime expected by its direct source transform.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

function makeStatus(): GitStatus {
  return {
    branch: 'main',
    detached: false,
    unborn: false,
    head: 'abc123',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    changes: [{ path: '/a.md', worktree: 'modified', conflicted: false }],
    truncated: false,
    operation: null,
  };
}

function gitValue(): GitValue {
  return {
    available: true,
    capabilities: null,
    repo: { isRepo: true },
    repositoryId: 'repo-1',
    remoteWeb: null,
    gitApi: null,
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

function press(target: EventTarget, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

describe('git dropdown keyboard contract', () => {
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

  /** Render `component` inside a git context and return its trigger. */
  async function renderMenu(component: Parameters<typeof createElement>[0], props: object) {
    await act(async () => {
      root.render(
        createElement(GitContext.Provider, { value: gitValue() }, createElement(component, props)),
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
    if (!trigger) throw new Error('menu trigger did not render');
    return trigger;
  }

  const items = () =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter(
      (item) => !item.disabled,
    );

  for (const scenario of [
    { name: 'GitStatusBar', component: GitStatusBar, props: {} },
    { name: 'GitToolbarControl', component: GitToolbarControl, props: { selectedFile: '/a.md' } },
  ] as const) {
    describe(scenario.name, () => {
      it('opens with ArrowDown and focuses the first item', async () => {
        const trigger = await renderMenu(scenario.component, scenario.props);
        await act(async () => {
          trigger.focus();
          press(trigger, 'ArrowDown');
        });

        expect(trigger.getAttribute('aria-expanded')).to.equal('true');
        expect(document.activeElement, 'focus must enter the menu').to.equal(items()[0]);
      });

      it('opens with ArrowUp and focuses the last item', async () => {
        const trigger = await renderMenu(scenario.component, scenario.props);
        await act(async () => {
          trigger.focus();
          press(trigger, 'ArrowUp');
        });
        const all = items();
        expect(document.activeElement).to.equal(all[all.length - 1]);
      });

      it('cycles items with the Arrow keys', async () => {
        const trigger = await renderMenu(scenario.component, scenario.props);
        await act(async () => {
          trigger.focus();
          press(trigger, 'ArrowDown');
        });
        const all = items();

        await act(async () => press(document.activeElement!, 'ArrowDown'));
        expect(document.activeElement).to.equal(all[1]);

        await act(async () => press(document.activeElement!, 'ArrowUp'));
        expect(document.activeElement).to.equal(all[0]);

        // Wraps off the top.
        await act(async () => press(document.activeElement!, 'ArrowUp'));
        expect(document.activeElement).to.equal(all[all.length - 1]);
      });

      it('jumps with Home and End', async () => {
        const trigger = await renderMenu(scenario.component, scenario.props);
        await act(async () => {
          trigger.focus();
          press(trigger, 'ArrowDown');
        });
        const all = items();

        await act(async () => press(document.activeElement!, 'End'));
        expect(document.activeElement).to.equal(all[all.length - 1]);
        await act(async () => press(document.activeElement!, 'Home'));
        expect(document.activeElement).to.equal(all[0]);
      });

      it('closes on Escape and returns focus to the trigger', async () => {
        const trigger = await renderMenu(scenario.component, scenario.props);
        await act(async () => {
          trigger.focus();
          press(trigger, 'ArrowDown');
        });
        expect(items().length).to.be.greaterThan(0);

        await act(async () => press(document.activeElement!, 'Escape'));

        expect(container.querySelector('[role="menu"]'), 'the menu must close').to.equal(null);
        expect(trigger.getAttribute('aria-expanded')).to.equal('false');
        expect(document.activeElement, 'focus must not be stranded').to.equal(trigger);
      });

      it('keeps its items out of the tab order', async () => {
        const trigger = await renderMenu(scenario.component, scenario.props);
        await act(async () => {
          trigger.focus();
          press(trigger, 'ArrowDown');
        });
        // A menu is entered with arrows; the trigger is the single tab stop.
        const all = items();
        expect(all.length, 'the menu must actually be open').to.be.greaterThan(0);
        for (const item of all) {
          expect(item.getAttribute('tabindex')).to.equal('-1');
        }
      });
    });
  }
});
