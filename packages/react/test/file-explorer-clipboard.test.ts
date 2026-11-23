/**
 * The file pane's "New document from clipboard" sits with the other ways to
 * make a document, and only when the host can read the clipboard for it.
 */
import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryFileSystemProvider } from '@bendyline/docblocks/filesystem';
import { FileExplorer, type FileExplorerProps } from '../src/FileExplorer/FileExplorer.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe('FileExplorer New document from clipboard', () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let provider: MemoryFileSystemProvider;

  async function render(props: Partial<FileExplorerProps>): Promise<void> {
    await act(async () => {
      root.render(createElement(FileExplorer, { provider, ...props }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }

  function toolbarLabels(): Array<string | null> {
    const actions = container.querySelector('.db-explorer-actions');
    return [...(actions?.querySelectorAll('button') ?? [])].map((button) =>
      button.getAttribute('aria-label'),
    );
  }

  beforeEach(() => {
    provider = new MemoryFileSystemProvider('mem', 'Memory');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await provider.v2.dispose();
  });

  it('sits between New File and Import, and asks the host to act', async () => {
    let requests = 0;
    await render({ onCreateFromClipboard: () => (requests += 1), onImportFiles: () => undefined });
    expect(toolbarLabels()).to.deep.equal([
      'Sort by name',
      'Sort by last modified',
      'New Folder',
      'New File',
      'New document from clipboard',
      'Import files',
    ]);
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="New document from clipboard"]',
    );
    await act(async () => button?.click());
    expect(requests).to.equal(1);
  });

  it('is left out when the host cannot make a document from the clipboard', async () => {
    await render({});
    expect(toolbarLabels()).to.not.include('New document from clipboard');
  });
});
