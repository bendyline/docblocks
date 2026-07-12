import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { FileTreeNode } from '../src/FileExplorer/FileTreeNode.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
// Supply the classic JSX runtime expected by its direct source transform.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe('FileTreeNode destructive confirmation', () => {
  it('does not invoke the session/provider mutation boundary when deletion is cancelled', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const originalConfirm = window.confirm;
    let fileExists = true;
    let mutationCalls = 0;

    try {
      window.confirm = () => false;
      await act(async () => {
        root.render(
          createElement(FileTreeNode, {
            entry: { kind: 'file', name: 'draft.md', path: '/draft.md' },
            depth: 0,
            expanded: false,
            selected: true,
            onToggle: () => undefined,
            onSelect: () => undefined,
            onDelete: async () => {
              mutationCalls += 1;
              fileExists = false;
            },
            onRename: async () => undefined,
          }),
        );
      });

      const more = container.querySelector<HTMLButtonElement>('[aria-label="More actions"]');
      expect(more).not.to.equal(null);
      await act(async () => more!.click());
      const deleteButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === 'Delete',
      );
      expect(deleteButton).not.to.equal(undefined);
      await act(async () => deleteButton!.click());

      expect(mutationCalls).to.equal(0);
      expect(fileExists).to.equal(true);
    } finally {
      window.confirm = originalConfirm;
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
