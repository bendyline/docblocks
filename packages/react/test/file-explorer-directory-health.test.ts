import { expect } from 'chai';
import * as React from 'react';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  FsError,
  MemoryFileSystemProvider,
  parseWorkspacePath,
} from '@bendyline/docblocks/filesystem';
import { FileExplorer } from '../src/FileExplorer/FileExplorer.js';
import { act } from './helpers/renderHook.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe('FileExplorer directory health', () => {
  it('shows a child failure beside its folder and retries only that folder', async () => {
    const provider = new MemoryFileSystemProvider('health', 'Health');
    await provider.v2.createDirectory(parseWorkspacePath('docs'), { mode: 'create' });
    await provider.v2.writeFile(
      parseWorkspacePath('docs/guide.md'),
      new TextEncoder().encode('# Guide'),
      { mode: 'create' },
    );
    const readDirectory = provider.v2.readDirectory.bind(provider.v2);
    let childUnavailable = true;
    provider.v2.readDirectory = async (path) => {
      if (path === parseWorkspacePath('docs') && childUnavailable) {
        throw new FsError('not-found', 'Directory not found.', {
          operation: 'list',
          path,
        });
      }
      return readDirectory(path);
    };

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(FileExplorer, { provider }));
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      const docs = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
        (row) => row.dataset.path === 'docs',
      );
      if (!docs) throw new Error('docs tree row missing');
      await act(async () => {
        docs.click();
        await new Promise((resolve) => setTimeout(resolve, 220));
      });

      const childAlert = container.querySelector<HTMLElement>('.db-tree-error--child');
      expect(childAlert?.dataset.directoryPath).to.equal('docs');
      expect(childAlert?.textContent).to.include("This folder can't be found.");
      expect(childAlert?.textContent).not.to.include('Directory not found.');
      expect(
        container.querySelector('.db-file-explorer > .db-tree-error:not(.db-tree-error--child)'),
        'a child read must not become a workspace-wide banner',
      ).to.equal(null);

      childUnavailable = false;
      const retry = childAlert?.querySelector<HTMLButtonElement>('.db-tree-error-retry');
      if (!retry) throw new Error('child retry button missing');
      await act(async () => {
        retry.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(container.querySelector('.db-tree-error--child')).to.equal(null);
      expect(
        [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].some(
          (row) => row.dataset.path === 'docs/guide.md',
        ),
      ).to.equal(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await provider.v2.dispose();
    }
  });

  it('names the failing file in the banner and flags unreadable files in the tree', async () => {
    const provider = new MemoryFileSystemProvider('health', 'Health');
    for (const name of ['Bendyline.md', 'notes.md']) {
      await provider.v2.writeFile(parseWorkspacePath(name), new TextEncoder().encode(name), {
        mode: 'create',
      });
    }
    const readDirectory = provider.v2.readDirectory.bind(provider.v2);
    let reads = 0;
    provider.v2.readDirectory = async (path) => {
      reads += 1;
      if (reads === 1) {
        throw new FsError('io', 'UNKNOWN: unknown error, read', {
          operation: 'list',
          path: parseWorkspacePath('Bendyline.md'),
        });
      }
      return (await readDirectory(path)).map((entry) =>
        entry.kind === 'file' && entry.name === 'Bendyline.md'
          ? { ...entry, readIssue: { code: 'io' as const, message: 'Held by a sync client.' } }
          : entry,
      );
    };

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(FileExplorer, { provider }));
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      const rootAlert = container.querySelector('.db-file-explorer > .db-tree-error');
      expect(rootAlert?.textContent).to.include("Bendyline.md couldn't be read.");
      expect(rootAlert?.textContent).not.to.include('UNKNOWN');

      const retry = container.querySelector<HTMLButtonElement>(
        '.db-file-explorer > .db-tree-error .db-tree-error-retry',
      );
      if (!retry) throw new Error('root retry button missing');
      await act(async () => {
        retry.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(container.querySelector('.db-file-explorer > .db-tree-error')).to.equal(null);
      const rows = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')];
      const locked = rows.find((row) => row.dataset.path === 'Bendyline.md');
      const readable = rows.find((row) => row.dataset.path === 'notes.md');
      expect(locked?.querySelector('.db-tree-read-issue')?.getAttribute('title')).to.equal(
        'Could not read this file: Held by a sync client.',
      );
      expect(locked?.getAttribute('aria-label')).to.equal(
        'Bendyline.md, could not be read: Held by a sync client.',
      );
      expect(readable?.querySelector('.db-tree-read-issue')).to.equal(null);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await provider.v2.dispose();
    }
  });
});
