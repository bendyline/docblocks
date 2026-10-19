import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { WelcomeScreen } from '../src/DocBlocksShell/WelcomeScreen.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

async function renderWelcome(offerApps?: boolean) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(WelcomeScreen, {
        onCreateDocument: () => undefined,
        onTour: () => undefined,
        onDismiss: () => undefined,
        offerApps,
      }),
    );
  });
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function appsLink(container: HTMLElement): HTMLAnchorElement | undefined {
  return Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).find(
    (link) => link.textContent?.trim() === 'Check out the DocBlocks apps',
  );
}

describe('WelcomeScreen', () => {
  it('offers the native apps in a new tab when asked', async () => {
    const { container, cleanup } = await renderWelcome(true);
    try {
      const link = appsLink(container);
      expect(link?.href).to.equal('https://docblocks.com/desktop/');
      expect(link?.target).to.equal('_blank');
      expect(link?.rel).to.equal('noopener noreferrer');
    } finally {
      await cleanup();
    }
  });

  it('leaves the apps link out by default', async () => {
    const { container, cleanup } = await renderWelcome();
    try {
      expect(appsLink(container)).to.equal(undefined);
    } finally {
      await cleanup();
    }
  });
});
