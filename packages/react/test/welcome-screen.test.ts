import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CompactWelcomeScreen,
  WELCOME_GREETING,
  WelcomeScreen,
} from '../src/DocBlocksShell/WelcomeScreen.js';

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
      expect(link?.href).to.equal('https://docblocks.com/docs/#apps');
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

describe('CompactWelcomeScreen', () => {
  it('routes each choice to its own handler', async () => {
    const calls: string[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(CompactWelcomeScreen, {
          onCreateDocument: () => calls.push('create'),
          onTour: () => calls.push('tour'),
          onDismiss: () => calls.push('dismiss'),
        }),
      );
    });
    try {
      const button = (name: string) =>
        Array.from(container.querySelectorAll('button')).find(
          (candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent) === name,
        );
      button('Create a document')?.click();
      button('Tour the welcome document')?.click();
      button('Dismiss welcome')?.click();
      expect(calls).to.deep.equal(['create', 'tour', 'dismiss']);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe('first-run greeting', () => {
  async function render(element: React.ReactElement) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(element));
    return {
      container,
      async cleanup() {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }
  const handlers = {
    onCreateDocument: () => undefined,
    onTour: () => undefined,
    onDismiss: () => undefined,
  };

  it('welcomes the user by default', async () => {
    const compact = await render(createElement(CompactWelcomeScreen, handlers));
    const wide = await render(createElement(WelcomeScreen, handlers));
    try {
      expect(compact.container.querySelector('h1')?.textContent).to.equal(WELCOME_GREETING);
      expect(wide.container.querySelector('.db-welcome-gateway-eyebrow')?.textContent).to.equal(
        WELCOME_GREETING,
      );
    } finally {
      await compact.cleanup();
      await wide.cleanup();
    }
  });

  it('leads with the host’s greeting when its own screen has already welcomed the user', async () => {
    const greeting = 'Your folder is ready';
    const compact = await render(createElement(CompactWelcomeScreen, { ...handlers, greeting }));
    const wide = await render(createElement(WelcomeScreen, { ...handlers, greeting }));
    try {
      const heading = compact.container.querySelector('h1');
      expect(heading?.textContent).to.equal(greeting);
      // The section is still named by its heading.
      expect(compact.container.querySelector('section')?.getAttribute('aria-labelledby')).to.equal(
        heading?.id,
      );
      expect(wide.container.querySelector('.db-welcome-gateway-eyebrow')?.textContent).to.equal(
        greeting,
      );
      expect(wide.container.textContent).to.not.contain(WELCOME_GREETING);
      expect(compact.container.textContent).to.not.contain(WELCOME_GREETING);
    } finally {
      await compact.cleanup();
      await wide.cleanup();
    }
  });
});
