import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { UpdateStatusItem } from '../renderer/UpdateStatusBanner.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe('desktop update status', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  it('renders download progress as a status-bar item', async () => {
    await act(async () => {
      root.render(
        createElement(UpdateStatusItem, { status: { kind: 'downloading', percent: 6.2 } }),
      );
    });

    const progress = container.querySelector('.db-desktop-update-status');
    expect(progress?.textContent).to.equal('Downloading update… 6%');
    expect(progress?.getAttribute('role')).to.equal('progressbar');
    expect(progress?.getAttribute('aria-valuenow')).to.equal('6');
  });

  it('puts the ready message and restart action in the status item', async () => {
    await act(async () => {
      root.render(
        createElement(UpdateStatusItem, {
          status: {
            kind: 'downloaded',
            version: '2.3.0',
            releaseUrl: 'https://example.com/release',
          },
        }),
      );
    });

    const item = container.querySelector('.db-desktop-update-status--ready');
    expect(item?.textContent).to.contain('DocBlocks 2.3.0 is ready to install.');
    expect(
      Array.from(item?.querySelectorAll('button') ?? []).map((button) => button.textContent),
    ).to.deep.equal(["What's new", 'Restart to install']);
  });

  it('stays quiet when no update is available', async () => {
    await act(async () => {
      root.render(createElement(UpdateStatusItem, { status: { kind: 'not-available' } }));
    });

    expect(container.childElementCount).to.equal(0);
  });
});
