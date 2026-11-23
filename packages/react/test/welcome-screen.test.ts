import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  COMPACT_WELCOME_BRING_CONTENT_LABEL,
  CompactWelcomeScreen,
  WELCOME_BRING_CONTENT_LABEL,
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

describe('bringing something to the welcome screen', () => {
  const handlers = {
    onCreateDocument: () => undefined,
    onTour: () => undefined,
    onDismiss: () => undefined,
  };

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

  function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === name,
    );
  }

  /** A paste event as a browser dispatches one, with its clipboard flavours. */
  function pasteEvent(flavours: Record<string, string>): Event {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => flavours[type] ?? '' },
    });
    return event;
  }

  it('offers the third choice only when the host can take it', async () => {
    const without = await render(createElement(WelcomeScreen, handlers));
    const opened: string[] = [];
    const wide = await render(
      createElement(WelcomeScreen, { ...handlers, onBringContent: () => opened.push('wide') }),
    );
    const compact = await render(
      createElement(CompactWelcomeScreen, {
        ...handlers,
        onBringContent: () => opened.push('compact'),
      }),
    );
    try {
      expect(buttonNamed(without.container, WELCOME_BRING_CONTENT_LABEL)).to.equal(undefined);
      // Second of the three, right after Create.
      const wideLabels = Array.from(
        wide.container.querySelectorAll('.db-welcome-gateway-actions button'),
      ).map((button) => button.textContent?.trim());
      expect(wideLabels).to.deep.equal([
        'Create a document',
        WELCOME_BRING_CONTENT_LABEL,
        'Tour the welcome document',
      ]);
      buttonNamed(wide.container, WELCOME_BRING_CONTENT_LABEL)?.click();
      buttonNamed(compact.container, COMPACT_WELCOME_BRING_CONTENT_LABEL)?.click();
      expect(opened).to.deep.equal(['wide', 'compact']);
    } finally {
      await without.cleanup();
      await wide.cleanup();
      await compact.cleanup();
    }
  });

  it('turns a paste with nothing focused into a document', async () => {
    const pasted: Array<{ text: string; html?: string | null }> = [];
    const view = await render(
      createElement(WelcomeScreen, {
        ...handlers,
        onBringContent: () => undefined,
        onPasteContent: (content) => pasted.push(content),
      }),
    );
    const field = document.createElement('textarea');
    document.body.append(field);
    try {
      const event = pasteEvent({ 'text/plain': '# Plan', 'text/html': '<h1>Plan</h1>' });
      document.body.dispatchEvent(event);
      expect(event.defaultPrevented).to.equal(true);
      // A field takes its own paste, and so does a handler that already did.
      field.dispatchEvent(pasteEvent({ 'text/plain': 'typed elsewhere' }));
      const handled = pasteEvent({ 'text/plain': 'dialog' });
      handled.preventDefault();
      document.body.dispatchEvent(handled);
      expect(pasted).to.deep.equal([{ text: '# Plan', html: '<h1>Plan</h1>' }]);
    } finally {
      field.remove();
      await view.cleanup();
    }
  });

  it('leaves pastes alone once it has gone', async () => {
    const pasted: unknown[] = [];
    const view = await render(
      createElement(WelcomeScreen, {
        ...handlers,
        onBringContent: () => undefined,
        onPasteContent: (content) => pasted.push(content),
      }),
    );
    await view.cleanup();
    document.body.dispatchEvent(pasteEvent({ 'text/plain': 'later' }));
    expect(pasted).to.deep.equal([]);
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
