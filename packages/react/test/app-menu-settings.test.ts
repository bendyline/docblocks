import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AppMenu } from '../src/AppMenu/AppMenu.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe('AppMenu settings', () => {
  it('uses the wide dialog and explains browser storage protection', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let persistenceRequests = 0;

    try {
      await act(async () => {
        root.render(
          createElement(AppMenu, {
            getStorageEstimate: async () => ({ usage: 1843, quota: 3 * 1024 ** 3 }),
            storagePersistent: false,
            onKeepBrowserData: async () => {
              persistenceRequests += 1;
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

      expect(container.querySelector('.db-about-version')?.textContent).to.contain('2.1.0 web');
      expect(container.querySelector('time')?.textContent).to.equal('2026-07-15');
      const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).map((link) => ({
        text: link.textContent?.trim(),
        href: link.href,
      }));
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
});
