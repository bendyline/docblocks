import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AppMenu } from '../src/AppMenu/AppMenu.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe('AppMenu settings', () => {
  it('requests persistent browser storage directly from the app menu', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let persistenceRequests = 0;

    try {
      await act(async () => {
        root.render(
          createElement(AppMenu, {
            onKeepBrowserData: async () => {
              persistenceRequests += 1;
            },
          }),
        );
      });

      await act(async () => {
        container.querySelector<HTMLButtonElement>('.db-app-menu-btn')?.click();
      });
      const persistenceButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Protect data from browser cleanup',
      );
      expect(persistenceButton).not.to.equal(undefined);

      await act(async () => persistenceButton?.click());

      expect(persistenceRequests).to.equal(1);
      expect(container.querySelector('.db-dialog')).to.equal(null);
      expect(container.querySelector('.db-app-menu-dropdown')).to.equal(null);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('closes Settings before requesting browser storage protection', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let persistenceRequests = 0;
    let finishPersistenceRequest: (() => void) | undefined;

    try {
      await act(async () => {
        root.render(
          createElement(AppMenu, {
            getStorageEstimate: async () => ({ usage: 1843, quota: 3 * 1024 ** 3 }),
            storagePersistent: false,
            onKeepBrowserData: async () => {
              persistenceRequests += 1;
              await new Promise<void>((resolve) => {
                finishPersistenceRequest = resolve;
              });
            },
          }),
        );
      });

      await act(async () => {
        container.querySelector<HTMLButtonElement>('.db-app-menu-btn')?.click();
      });
      const settingsButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Settings',
      );
      await act(async () => settingsButton?.click());

      expect(container.querySelector('.db-dialog--wide')).not.to.equal(null);
      expect(container.querySelectorAll('.db-settings-accent')).to.have.length(7);
      expect(container.textContent).to.include(
        'Browsers may clear site data under storage pressure unless protection is granted.',
      );
      expect(container.textContent).not.to.include('in the app menu');

      const persistenceButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Protect data from browser cleanup',
      );
      expect(persistenceButton).not.to.equal(undefined);
      await act(async () => persistenceButton?.click());
      expect(persistenceRequests).to.equal(1);
      expect(container.querySelector('.db-dialog')).to.equal(null);

      await act(async () => finishPersistenceRequest?.());
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('shows selectable version metadata and customer support links in About', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(AppMenu, {
            appVersion: '2.1.0 web',
            appBuildDate: '2026-07-15',
          }),
        );
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.db-app-menu-btn')?.click();
      });
      const aboutButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'About',
      );
      await act(async () => aboutButton?.click());

      // App Review rejects apps that label themselves beta (guideline 2.2).
      expect(container.textContent).not.to.match(/\bbeta\b/i);
      expect(container.querySelector('.db-about-version')?.textContent).to.contain('2.1.0 web');
      expect(container.querySelector('time')?.textContent).to.equal('2026-07-15');
      const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).map((link) => ({
        text: link.textContent?.trim(),
        href: link.href,
      }));
      expect(links).to.deep.include({
        text: 'More information...',
        href: 'https://docblocks.com/web/',
      });
      expect(links).to.deep.include({
        text: 'Release notes',
        href: 'https://github.com/bendyline/docblocks/releases',
      });
      expect(links).to.deep.include({
        text: 'Support',
        href: 'https://github.com/bendyline/docblocks/issues',
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('links Electron users to the Desktop information page', async () => {
    const hostGlobal = globalThis as typeof globalThis & {
      docBlocksHost?: Record<string, unknown>;
    };
    // The surface is read from the declared environment now, not inferred from
    // the presence of an `fs` bridge.
    hostGlobal.docBlocksHost = {
      env: {
        surface: 'electron',
        surfaceLabel: 'desktop',
        platform: 'darwin',
        appVersion: '0.0.0-test',
        isDev: true,
      },
      fs: {},
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(AppMenu));
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.db-app-menu-btn')?.click();
      });
      const aboutButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'About',
      );
      await act(async () => aboutButton?.click());

      const moreInformationLink = Array.from(
        container.querySelectorAll<HTMLAnchorElement>('a'),
      ).find((link) => link.textContent?.trim() === 'More information...');
      expect(moreInformationLink?.href).to.equal('https://docblocks.com/desktop/');
    } finally {
      delete hostGlobal.docBlocksHost;
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('groups the safety actions and offers Help: shortcuts and documentation', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let backups = 0;
    let sheets = 0;

    try {
      await act(async () => {
        root.render(
          createElement(AppMenu, {
            onDownloadAllWorkspaces: () => {
              backups += 1;
            },
            onKeepBrowserData: async () => undefined,
            onShowKeyboardShortcuts: () => {
              sheets += 1;
            },
          }),
        );
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.db-app-menu-btn')?.click();
      });

      const menu = container.querySelector('.db-app-menu-dropdown');
      const entries = [...(menu?.children ?? [])].map((child) =>
        child.classList.contains('db-app-menu-divider')
          ? '---'
          : (child.firstChild?.textContent ?? '').trim(),
      );
      expect(entries).to.deep.equal([
        'Settings',
        '---',
        'Back up all workspaces',
        'Protect data from browser cleanup',
        '---',
        'Keyboard shortcuts',
        'Documentation',
        'About',
      ]);

      const docs = menu?.querySelector<HTMLAnchorElement>('a[role="menuitem"]');
      expect(docs?.getAttribute('href')).to.equal('https://docblocks.com/docs/');
      expect(docs?.getAttribute('target')).to.equal('_blank');

      const shortcuts = [...(menu?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (button) => button.getAttribute('aria-keyshortcuts') === 'F1',
      );
      await act(async () => shortcuts?.click());
      expect(sheets).to.equal(1);
      expect(container.querySelector('.db-app-menu-dropdown')).to.equal(null);

      await act(async () => {
        container.querySelector<HTMLButtonElement>('.db-app-menu-btn')?.click();
      });
      const backup = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === 'Back up all workspaces',
      );
      await act(async () => backup?.click());
      expect(backups).to.equal(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
