import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { FileSystemEntry } from '@bendyline/docblocks/filesystem';
import { FileTreeNode, type FileTreeNodeProps } from '../src/FileExplorer/FileTreeNode.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
// Supply the classic JSX runtime expected by its direct source transform.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const FILE: FileSystemEntry = { kind: 'file', name: 'draft.md', path: '/draft.md' };

/** Write through the prototype setter so React's value tracker sees a change. */
function typeInto(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element) as object,
    'value',
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function clickContextItem(label: string): void {
  const item = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === label,
  );
  if (!item) throw new Error(`No context-menu item "${label}"`);
  item.click();
}

/** Open the row's context menu and start a rename, returning the input. */
async function startRename(container: HTMLElement): Promise<HTMLInputElement> {
  const more = container.querySelector<HTMLButtonElement>('[aria-label="More actions"]');
  if (!more) throw new Error('No More actions button');
  await act(async () => more.click());
  await act(async () => clickContextItem('Rename'));
  const input = container.querySelector<HTMLInputElement>('.db-tree-rename-input');
  if (!input) throw new Error('Rename input did not render');
  return input;
}

function baseProps(overrides: Partial<FileTreeNodeProps> = {}): FileTreeNodeProps {
  return {
    entry: FILE,
    depth: 0,
    expanded: false,
    selected: false,
    onToggle: () => undefined,
    onSelect: () => undefined,
    onDelete: async () => undefined,
    onRename: async () => undefined,
    ...overrides,
  };
}

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

  it('surfaces a failed delete instead of leaving the row looking untouched', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const originalConfirm = window.confirm;

    try {
      window.confirm = () => true;
      await act(async () => {
        root.render(
          createElement(
            FileTreeNode,
            baseProps({
              onDelete: async () => {
                throw new Error('The document is open elsewhere.');
              },
            }),
          ),
        );
      });

      const more = container.querySelector<HTMLButtonElement>('[aria-label="More actions"]');
      await act(async () => more!.click());
      await act(async () => clickContextItem('Delete'));

      const alert = container.querySelector('[role="alert"]');
      expect(alert, 'a failed delete must be surfaced').not.to.equal(null);
      expect(alert?.textContent).to.include('The document is open elsewhere.');
    } finally {
      window.confirm = originalConfirm;
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe('FileTreeNode rename', () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('does not select the pre-rename path when Enter confirms the rename', async () => {
    // Regression: the input's keydown bubbled to the row, whose Enter
    // handler opened the OLD path while the rename was moving it — a race
    // that surfaced as a spurious "Unable to move this entry".
    const selected: string[] = [];
    const renames: string[][] = [];

    await act(async () => {
      root.render(
        createElement(
          FileTreeNode,
          baseProps({
            entry: { kind: 'file', name: 'draft.md', path: '/notes/draft.md' },
            onSelect: (path) => selected.push(path),
            onRename: async (oldPath, newPath, kind) => {
              renames.push([oldPath, newPath, kind]);
            },
          }),
        ),
      );
    });

    const input = await startRename(container);
    await act(async () => typeInto(input, 'renamed.md'));
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(renames).to.deep.equal([['/notes/draft.md', '/notes/renamed.md', 'file']]);
    expect(selected, 'Enter must not also click the row').to.deep.equal([]);
  });

  it('does not toggle a directory when Enter confirms its rename', async () => {
    const toggled: string[] = [];
    const selected: string[] = [];

    await act(async () => {
      root.render(
        createElement(
          FileTreeNode,
          baseProps({
            entry: { kind: 'directory', name: 'notes', path: '/notes' },
            onToggle: (path) => toggled.push(path),
            onSelect: (path) => selected.push(path),
          }),
        ),
      );
    });

    const input = await startRename(container);
    await act(async () => typeInto(input, 'archive'));
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(toggled).to.deep.equal([]);
    expect(selected).to.deep.equal([]);
  });

  it('still activates the row on Enter when not renaming', async () => {
    const selected: string[] = [];
    await act(async () => {
      root.render(
        createElement(FileTreeNode, baseProps({ onSelect: (path) => selected.push(path) })),
      );
    });

    const row = container.querySelector<HTMLElement>('.db-tree-row');
    await act(async () => {
      row!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(selected).to.deep.equal(['/draft.md']);
  });

  it('submits once when Enter is followed by a blur', async () => {
    let renameCalls = 0;
    let release: (() => void) | null = null;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    await act(async () => {
      root.render(
        createElement(
          FileTreeNode,
          baseProps({
            onRename: async () => {
              renameCalls += 1;
              await pending;
            },
          }),
        ),
      );
    });

    const input = await startRename(container);
    await act(async () => typeInto(input, 'renamed.md'));
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(
      container.querySelector('.db-tree-rename-input'),
      'Enter should leave rename mode before the asynchronous move finishes',
    ).to.equal(null);
    expect(document.activeElement).to.equal(container.querySelector('.db-tree-row'));

    // The blur that lands while the rename is still in flight must not
    // fire a second rename against an entry that is already moving.
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    await act(async () => {
      release?.();
      await pending;
    });

    expect(renameCalls).to.equal(1);
  });

  it('does not rename when Escape cancels', async () => {
    let renameCalls = 0;
    await act(async () => {
      root.render(
        createElement(
          FileTreeNode,
          baseProps({
            onRename: async () => {
              renameCalls += 1;
            },
          }),
        ),
      );
    });

    const input = await startRename(container);
    await act(async () => typeInto(input, 'renamed.md'));
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    // A blur after the cancel must not resurrect the abandoned rename.
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(renameCalls).to.equal(0);
    expect(container.querySelector('.db-tree-rename-input')).to.equal(null);
  });
});

describe('FileTreeNode context menu', () => {
  it('removes its scroll listener when the menu closes by click', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const originalAdd = document.addEventListener.bind(document);
    const originalRemove = document.removeEventListener.bind(document);
    let scrollListeners = 0;

    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'scroll') scrollListeners += 1;
      return (originalAdd as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'scroll') scrollListeners -= 1;
      return (originalRemove as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof document.removeEventListener;

    try {
      await act(async () => {
        root.render(createElement(FileTreeNode, baseProps()));
      });

      // Each open/close cycle used to strand an anonymous scroll listener
      // that fired setState on an unmounted row at the next scroll.
      const more = container.querySelector<HTMLButtonElement>('[aria-label="More actions"]');
      for (let i = 0; i < 3; i += 1) {
        await act(async () => more!.click());
        await act(async () => document.body.click());
      }

      expect(scrollListeners, 'scroll listeners must not accumulate').to.equal(0);
    } finally {
      document.addEventListener = originalAdd;
      document.removeEventListener = originalRemove;
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
