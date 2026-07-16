import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { UpdateAvailableNotice } from '../src/DocBlocksShell/UpdateAvailableNotice.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe('UpdateAvailableNotice', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(UpdateAvailableNotice, {
          available: true,
          onApplyUpdate: () => undefined,
          statusBarVisible: true,
        }),
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  it('starts with a prominent update prompt and keeps the status notice available', async () => {
    const notice = container.querySelector<HTMLButtonElement>('.db-update-status-notice');
    expect(notice?.textContent).to.equal('Update available');
    const prompt = container.querySelector('.db-update-banner');
    expect(prompt?.textContent).to.contain('A new version of DocBlocks is available.');
    expect(prompt?.textContent).to.contain('site pages');
    expect(prompt?.textContent).to.contain('Reload');
    expect(prompt?.textContent).to.contain('Later');
    expect(notice?.getAttribute('aria-expanded')).to.equal('true');
  });

  it('closes the prompt with Later while keeping the status notice available', async () => {
    const later = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Later',
    );
    await act(async () => later?.click());

    expect(container.querySelector('.db-update-banner')).to.equal(null);
    expect(container.querySelector('.db-update-status-notice')).not.to.equal(null);
  });

  it('calls the update callback from the Reload action', async () => {
    let applyCalls = 0;
    await act(async () => {
      root.render(
        createElement(UpdateAvailableNotice, {
          available: true,
          onApplyUpdate: () => {
            applyCalls += 1;
          },
          statusBarVisible: true,
        }),
      );
    });

    const reload = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Reload',
    );
    await act(async () => reload?.click());

    expect(applyCalls).to.equal(1);
  });
});
