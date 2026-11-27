import { expect } from 'chai';
import * as React from 'react';
import { createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryFileSystemProvider, parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import {
  FileExplorer,
  type FileExplorerHandle,
  type FileTreeChange,
} from '../src/FileExplorer/FileExplorer.js';
import { act } from './helpers/renderHook.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
// Supply the classic JSX runtime expected by its direct source transform.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const encoder = new TextEncoder();

async function writeFile(provider: MemoryFileSystemProvider, path: string, text: string) {
  await provider.v2.writeFile(parseWorkspacePath(path), encoder.encode(text), {
    mode: 'create',
    createParents: true,
  });
}

async function exists(provider: MemoryFileSystemProvider, path: string): Promise<boolean> {
  return (await provider.v2.stat(parseWorkspacePath(path))) !== null;
}

describe('FileExplorer rename handle', () => {
  it('renames through the tree hooks and carries the companion folder', async () => {
    const provider = new MemoryFileSystemProvider('mem', 'Memory');
    await writeFile(provider, 'notes.md', '# Notes\n\n![](notes_files/chart.png)');
    await writeFile(provider, 'notes_files/chart.png', 'png');

    const mutations: FileTreeChange[] = [];
    const changes: (FileTreeChange | undefined)[] = [];
    const ref = createRef<FileExplorerHandle>();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(FileExplorer, {
            ref,
            provider,
            activeFilePath: '/notes.md',
            onTreeMutation: async (change, mutate) => {
              mutations.push(change);
              await mutate();
            },
            onTreeChange: (change) => changes.push(change),
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      await act(async () => {
        await ref.current?.renameEntry('/notes.md', '/plan.md', 'file');
      });

      const move: FileTreeChange = {
        type: 'move',
        oldPath: '/notes.md',
        newPath: '/plan.md',
        kind: 'file',
      };
      expect(mutations).to.deep.equal([move]);
      expect(changes).to.deep.equal([move]);
      expect(await exists(provider, 'plan.md')).to.equal(true);
      expect(await exists(provider, 'plan_files/chart.png')).to.equal(true);
      expect(await exists(provider, 'notes.md')).to.equal(false);
      expect(await exists(provider, 'notes_files')).to.equal(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await provider.v2.dispose();
    }
  });

  it('rejects to the caller instead of showing the failure in the tree', async () => {
    const provider = new MemoryFileSystemProvider('mem', 'Memory');
    await writeFile(provider, 'notes.md', '# Notes');
    await writeFile(provider, 'plan.md', '# Plan');

    const ref = createRef<FileExplorerHandle>();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(FileExplorer, { ref, provider }));
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      let failure: unknown = null;
      await act(async () => {
        try {
          await ref.current?.renameEntry('/notes.md', '/plan.md', 'file');
        } catch (caught: unknown) {
          failure = caught;
        }
      });

      expect(failure).to.be.instanceOf(Error);
      expect(container.querySelector('.db-tree-error')).to.equal(null);
      expect(await exists(provider, 'notes.md')).to.equal(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await provider.v2.dispose();
    }
  });
});
