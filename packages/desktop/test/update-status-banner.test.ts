import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorProvider, StatusBar } from '@bendyline/squisq-editor-react';
import { UpdateStatusItem } from '../renderer/UpdateStatusBanner.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const updateStyles = readFileSync(
  fileURLToPath(new URL('../renderer/update-banner.css', import.meta.url)),
  'utf8',
);

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

  it('renders download progress inside the Squisq status bar slot', async () => {
    await act(async () => {
      root.render(
        createElement(
          EditorProvider,
          { initialMarkdown: '# Draft', articleId: 'update-status-test' },
          createElement(StatusBar, {
            slotRight: createElement(UpdateStatusItem, {
              status: { kind: 'downloading', percent: 6.2 },
            }),
          }),
        ),
      );
    });

    const progress = container.querySelector('.db-desktop-update-status');
    expect(progress?.parentElement?.classList.contains('squisq-status-bar')).to.equal(true);
  });

  it('uses Hanken Grotesk for desktop updater text', () => {
    expect(updateStyles).to.match(
      /\.db-desktop-update-status\s*\{[^}]*font-family:\s*'Hanken Grotesk',\s*system-ui,\s*sans-serif;/s,
    );
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

  it('shows the complete human-readable error without a misleading check prefix', async () => {
    await act(async () => {
      root.render(
        createElement(UpdateStatusItem, {
          status: {
            kind: 'error',
            message: 'DocBlocks couldn\u2019t reach the update server. Check your connection.',
          },
        }),
      );
    });

    const error = container.querySelector('.db-desktop-update-status--error');
    expect(error?.textContent).to.contain(
      'DocBlocks couldn\u2019t reach the update server. Check your connection.',
    );
    expect(error?.textContent).not.to.contain('Update check failed');
    expect(error?.getAttribute('role')).to.equal('alert');
  });
});
