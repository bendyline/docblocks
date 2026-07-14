import { expect } from 'chai';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { UpdateAvailableNotice } from '../src/DocBlocksShell/UpdateAvailableNotice.js';

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

  it('starts as a status notice and opens the existing update prompt on click', async () => {
    const notice = container.querySelector<HTMLButtonElement>('.db-update-status-notice');
    expect(notice?.textContent).to.equal('Update available');
    expect(container.querySelector('.db-update-banner')).to.equal(null);

    await act(async () => notice?.click());

    const prompt = container.querySelector('.db-update-banner');
    expect(prompt?.textContent).to.contain('A new version of DocBlocks is available.');
    expect(prompt?.textContent).to.contain('Reload');
    expect(prompt?.textContent).to.contain('Later');
    expect(notice?.getAttribute('aria-expanded')).to.equal('true');
  });

  it('closes the prompt with Later while keeping the status notice available', async () => {
    const notice = container.querySelector<HTMLButtonElement>('.db-update-status-notice');
    await act(async () => notice?.click());

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

    const notice = container.querySelector<HTMLButtonElement>('.db-update-status-notice');
    await act(async () => notice?.click());
    const reload = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Reload',
    );
    await act(async () => reload?.click());

    expect(applyCalls).to.equal(1);
  });
});
