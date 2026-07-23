import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { FileSystemEntry, FileSystemProvider } from '@bendyline/docblocks/filesystem';
import { FileExplorer } from '../src/FileExplorer/FileExplorer.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const ROOT_ENTRIES: FileSystemEntry[] = [
  {
    kind: 'file',
    name: 'a-old-root.md',
    path: 'a-old-root.md',
    lastModified: '2026-07-20T10:00:00.000Z',
  },
  { kind: 'directory', name: 'z-folder', path: 'z-folder' },
  {
    kind: 'file',
    name: 'z-new-root.md',
    path: 'z-new-root.md',
    lastModified: '2026-07-22T10:00:00.000Z',
  },
  { kind: 'directory', name: 'a-folder', path: 'a-folder' },
];

const CHILD_ENTRIES: FileSystemEntry[] = [
  {
    kind: 'file',
    name: 'a-old-child.md',
    path: 'a-folder/a-old-child.md',
    lastModified: '2026-07-19T10:00:00.000Z',
  },
  {
    kind: 'file',
    name: 'z-new-child.md',
    path: 'a-folder/z-new-child.md',
    lastModified: '2026-07-21T10:00:00.000Z',
  },
];

function createProvider(): FileSystemProvider {
  return {
    id: 'sorting',
    label: 'Sorting',
    readFile: async () => null,
    writeFile: async () => undefined,
    delete: async () => undefined,
    rename: async () => undefined,
    readDirectory: async (path) => {
      if (path === '' || path === '/') return ROOT_ENTRIES;
      if (path === 'a-folder' || path === '/a-folder') return CHILD_ENTRIES;
      return [];
    },
    exists: async () => false,
    createDirectory: async () => undefined,
    stat: async () => null,
    readBinary: async () => null,
    writeBinary: async () => undefined,
  };
}

function renderedPaths(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].map(
    (row) => row.dataset.path ?? '',
  );
}

describe('FileExplorer sorting toolbar', () => {
  it('sorts every sibling list without moving folders below files', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(FileExplorer, { provider: createProvider() }));
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(renderedPaths(container)).to.deep.equal([
        'a-folder',
        'z-folder',
        'a-old-root.md',
        'z-new-root.md',
      ]);

      const modifiedButton = container.querySelector<HTMLButtonElement>(
        '[aria-label="Sort by last modified"]',
      );
      if (!modifiedButton) throw new Error('Sort by last modified button missing');
      await act(async () => modifiedButton.click());

      expect(modifiedButton.getAttribute('aria-pressed')).to.equal('true');
      expect(
        container.querySelector('[aria-label="Sort by name"]')?.getAttribute('aria-pressed'),
      ).to.equal('false');
      expect(renderedPaths(container)).to.deep.equal([
        'a-folder',
        'z-folder',
        'z-new-root.md',
        'a-old-root.md',
      ]);

      const folder = container.querySelector<HTMLElement>('[data-path="a-folder"]');
      if (!folder) throw new Error('a-folder tree row missing');
      await act(async () => {
        folder.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(renderedPaths(container)).to.deep.equal([
        'a-folder',
        'a-folder/z-new-child.md',
        'a-folder/a-old-child.md',
        'z-folder',
        'z-new-root.md',
        'a-old-root.md',
      ]);

      const newChild = container.querySelector<HTMLElement>(
        '[data-path="a-folder/z-new-child.md"]',
      );
      const oldChild = container.querySelector<HTMLElement>(
        '[data-path="a-folder/a-old-child.md"]',
      );
      if (!newChild || !oldChild) throw new Error('sorted child rows missing');
      await act(async () => {
        newChild.focus();
      });
      await act(async () => {
        newChild.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
        );
      });
      expect(document.activeElement).to.equal(oldChild);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
