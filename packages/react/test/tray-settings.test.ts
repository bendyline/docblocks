import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DocBlocksHostMenuAPI, HostPlatform } from '@bendyline/docblocks/host';

import { TraySettingsControls } from '../src/Settings/TraySettings.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function fakeMenu(initial: boolean, options: { failWrite?: boolean } = {}) {
  let enabled = initial;
  const writes: boolean[] = [];
  const menu: DocBlocksHostMenuAPI = {
    setPinnedDocuments: () => undefined,
    getTrayEnabled: async () => enabled,
    setTrayEnabled: async (next) => {
      writes.push(next);
      if (options.failWrite) throw new Error('settings.json is read-only');
      enabled = next;
      return enabled;
    },
  };
  return { menu, writes };
}

async function render(menu: DocBlocksHostMenuAPI, platform: HostPlatform) {
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(TraySettingsControls, { menu, platform }));
  });
  const checkbox = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { container, checkbox, cleanup };
}

describe('TraySettingsControls', () => {
  it('reads the saved choice and turns the icon on', async () => {
    const { menu, writes } = fakeMenu(false);
    const view = await render(menu, 'darwin');
    try {
      expect(view.container.textContent).to.include('Show DocBlocks in the menu bar');
      expect(view.checkbox().checked).to.equal(false);
      expect(view.checkbox().disabled).to.equal(false);

      await act(async () => view.checkbox().click());

      expect(writes).to.deep.equal([true]);
      expect(view.checkbox().checked).to.equal(true);
    } finally {
      await view.cleanup();
    }
  });

  it('names the place each desktop gives the icon', async () => {
    for (const [platform, label] of [
      ['win32', 'Show DocBlocks in the notification area'],
      ['linux', 'Show DocBlocks in the system tray'],
    ] as const) {
      const view = await render(fakeMenu(true).menu, platform);
      try {
        expect(view.container.textContent).to.include(label);
        expect(view.checkbox().checked).to.equal(true);
      } finally {
        await view.cleanup();
      }
    }
  });

  it('puts the switch back and says so when the host cannot save it', async () => {
    const { menu, writes } = fakeMenu(false, { failWrite: true });
    const view = await render(menu, 'darwin');
    try {
      await act(async () => view.checkbox().click());

      expect(writes).to.deep.equal([true]);
      expect(view.checkbox().checked).to.equal(false);
      expect(view.container.querySelector('[role="alert"]')?.textContent).to.include(
        'could not change this setting',
      );
    } finally {
      await view.cleanup();
    }
  });
});
