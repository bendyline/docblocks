import { expect } from 'chai';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AppMenu } from '../src/AppMenu/AppMenu.js';

describe('AppMenu settings', () => {
  it('uses the wide dialog and offers persistent storage directly', async () => {
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
      expect(container.textContent).to.include('Data is not yet marked persistent.');
      expect(container.textContent).not.to.include('in the app menu');

      const persistenceButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Keep data in browser for longer',
      );
      expect(persistenceButton).not.to.equal(undefined);
      await act(async () => persistenceButton?.click());
      expect(persistenceRequests).to.equal(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
