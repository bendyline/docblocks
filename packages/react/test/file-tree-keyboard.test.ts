/**
 * The file tree must be fully operable from the keyboard (SF-5).
 *
 * Before this was implemented the tree was a keyboard dead end: every row
 * was a tab stop with only Enter handled, the "More actions" button was
 * tabIndex={-1} with no key that opened it, and the portal menu had no
 * roles and no key handling — so rename and delete were unreachable
 * without a mouse.
 *
 * These tests drive real key events, not the pure helpers (see
 * tree-keyboard.test.ts for those).
 */
import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  MemoryFileSystemProvider,
  parseWorkspacePath,
  type FileSystemEntry,
} from '@bendyline/docblocks/filesystem';
import { FileExplorer } from '../src/FileExplorer/FileExplorer.js';
import { FileTreeNode, type FileTreeNodeProps } from '../src/FileExplorer/FileTreeNode.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
// Supply the classic JSX runtime expected by its direct source transform.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const FILE: FileSystemEntry = { kind: 'file', name: 'draft.md', path: '/draft.md' };

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

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

function menuItems(): HTMLButtonElement[] {
  return [
    ...document.body.querySelectorAll<HTMLButtonElement>('.db-tree-context [role="menuitem"]'),
  ];
}

describe('FileTreeNode keyboard access', () => {
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

  async function renderNode(overrides: Partial<FileTreeNodeProps> = {}): Promise<HTMLElement> {
    await act(async () => {
      root.render(createElement(FileTreeNode, baseProps(overrides)));
    });
    const row = container.querySelector<HTMLElement>('.db-tree-row');
    if (!row) throw new Error('row did not render');
    return row;
  }

  it('opens the actions menu with Shift+F10 and focuses its first item', async () => {
    const row = await renderNode();
    await act(async () => {
      row.focus();
      press(row, 'F10', { shiftKey: true });
    });

    const items = menuItems();
    expect(items.length, 'the menu must open from the keyboard').to.be.greaterThan(0);
    expect(document.activeElement, 'focus must move into the menu').to.equal(items[0]);
  });

  it('opens the actions menu with the ContextMenu key', async () => {
    const row = await renderNode();
    await act(async () => {
      row.focus();
      press(row, 'ContextMenu');
    });
    expect(menuItems().length).to.be.greaterThan(0);
  });

  it('exposes the menu as a menu with menuitems', async () => {
    const row = await renderNode();
    await act(async () => {
      row.focus();
      press(row, 'F10', { shiftKey: true });
    });

    const menu = document.body.querySelector('.db-tree-context');
    expect(menu?.getAttribute('role')).to.equal('menu');
    expect(menu?.getAttribute('aria-label')).to.include('draft.md');
    expect(menuItems().map((item) => item.textContent?.trim())).to.deep.equal(['Rename', 'Delete']);
  });

  it('moves between menu items with Arrow keys and wraps', async () => {
    const row = await renderNode();
    await act(async () => {
      row.focus();
      press(row, 'F10', { shiftKey: true });
    });
    const items = menuItems();
    expect(document.activeElement).to.equal(items[0]);

    await act(async () => press(document.activeElement!, 'ArrowDown'));
    expect(document.activeElement).to.equal(items[1]);

    // Wrapping is what makes a 2-item menu usable without looking.
    await act(async () => press(document.activeElement!, 'ArrowDown'));
    expect(document.activeElement).to.equal(items[0]);

    await act(async () => press(document.activeElement!, 'ArrowUp'));
    expect(document.activeElement).to.equal(items[1]);
  });

  it('jumps to the first and last items with Home and End', async () => {
    const row = await renderNode();
    await act(async () => {
      row.focus();
      press(row, 'F10', { shiftKey: true });
    });
    const items = menuItems();

    await act(async () => press(document.activeElement!, 'End'));
    expect(document.activeElement).to.equal(items[items.length - 1]);
    await act(async () => press(document.activeElement!, 'Home'));
    expect(document.activeElement).to.equal(items[0]);
  });

  it('closes on Escape and hands focus back to the row', async () => {
    const row = await renderNode();
    await act(async () => {
      row.focus();
      press(row, 'F10', { shiftKey: true });
    });
    expect(menuItems().length).to.be.greaterThan(0);

    await act(async () => press(document.activeElement!, 'Escape'));

    expect(document.body.querySelector('.db-tree-context'), 'the menu must close').to.equal(null);
    expect(document.activeElement, 'focus must not be lost to the body').to.equal(row);
  });

  it('renames from the keyboard, end to end', async () => {
    // The headline of SF-5: this was impossible without a mouse.
    const renames: string[][] = [];
    const row = await renderNode({
      onRename: async (oldPath, newPath, kind) => {
        renames.push([oldPath, newPath, kind]);
      },
    });

    await act(async () => {
      row.focus();
      press(row, 'F10', { shiftKey: true });
    });
    await act(async () => (document.activeElement as HTMLButtonElement).click());

    const input = container.querySelector<HTMLInputElement>('.db-tree-rename-input');
    expect(input, 'Rename must open the input').to.not.equal(null);
    expect(document.activeElement, 'the rename input must take focus').to.equal(input);

    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input!) as object,
      'value',
    )?.set;
    setter?.call(input!, 'renamed.md');
    await act(async () => {
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => press(input!, 'Enter'));

    // A root-level entry has no parent prefix to rebuild — matches the
    // existing mouse-driven rename exactly.
    expect(renames).to.deep.equal([['/draft.md', 'renamed.md', 'file']]);
  });

  it('starts a rename with F2', async () => {
    const row = await renderNode();
    await act(async () => {
      row.focus();
      press(row, 'F2');
    });
    expect(container.querySelector('.db-tree-rename-input')).to.not.equal(null);
  });

  it('deletes with the Delete key, honouring the confirmation', async () => {
    const originalConfirm = window.confirm;
    const deleted: string[] = [];
    try {
      window.confirm = () => true;
      const row = await renderNode({
        onDelete: async (path) => {
          deleted.push(path);
        },
      });
      await act(async () => {
        row.focus();
        press(row, 'Delete');
      });
      expect(deleted).to.deep.equal(['/draft.md']);
    } finally {
      window.confirm = originalConfirm;
    }
  });

  it('does not delete when the confirmation is declined', async () => {
    const originalConfirm = window.confirm;
    const deleted: string[] = [];
    try {
      window.confirm = () => false;
      const row = await renderNode({
        onDelete: async (path) => {
          deleted.push(path);
        },
      });
      await act(async () => {
        row.focus();
        press(row, 'Delete');
      });
      expect(deleted).to.deep.equal([]);
    } finally {
      window.confirm = originalConfirm;
    }
  });

  it('does not act on keystrokes from the rename input', async () => {
    // The row must not delete the entry the user is busy renaming.
    const originalConfirm = window.confirm;
    const deleted: string[] = [];
    try {
      window.confirm = () => true;
      const row = await renderNode({
        onDelete: async (path) => {
          deleted.push(path);
        },
      });
      await act(async () => {
        row.focus();
        press(row, 'F2');
      });
      const input = container.querySelector<HTMLInputElement>('.db-tree-rename-input');
      await act(async () => press(input!, 'Delete'));
      expect(deleted).to.deep.equal([]);
    } finally {
      window.confirm = originalConfirm;
    }
  });

  it('exposes its depth and position to assistive tech', async () => {
    const row = await renderNode({ depth: 2, posInSet: 2, setSize: 5 });
    expect(row.getAttribute('aria-level')).to.equal('3');
    expect(row.getAttribute('aria-posinset')).to.equal('2');
    expect(row.getAttribute('aria-setsize')).to.equal('5');
  });

  it('uses compact indentation for nested rows', async () => {
    const row = await renderNode({ depth: 2 });
    expect(row.style.paddingLeft).to.equal('28px');
  });

  it('does not reserve disclosure-icon space for nested files', async () => {
    const row = await renderNode({ depth: 1 });
    expect(row.style.paddingLeft).to.equal('16px');
    expect(row.querySelector('.db-tree-icon')).to.equal(null);
  });

  it('keeps the disclosure icon for nested folders', async () => {
    const row = await renderNode({
      depth: 1,
      entry: { kind: 'directory', name: 'guides', path: '/guides' },
    });
    expect(row.querySelector('.db-tree-icon')).not.to.equal(null);
  });

  it('leaves the tab stop to the tree via the focusable prop', async () => {
    const row = await renderNode({ focusable: false });
    expect(row.getAttribute('tabindex')).to.equal('-1');
    const stop = await renderNode({ focusable: true });
    expect(stop.getAttribute('tabindex')).to.equal('0');
  });
});

describe('FileExplorer tree navigation', () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let provider: MemoryFileSystemProvider;

  beforeEach(async () => {
    provider = new MemoryFileSystemProvider('mem', 'Memory');
    await provider.v2.createDirectory(parseWorkspacePath('notes'), { mode: 'create' });
    await provider.v2.writeFile(
      parseWorkspacePath('notes/nested.md'),
      new TextEncoder().encode('# Nested'),
      { mode: 'create' },
    );
    await provider.v2.writeFile(parseWorkspacePath('zebra.md'), new TextEncoder().encode('# Z'), {
      mode: 'create',
    });

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(FileExplorer, { provider }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await provider.v2.dispose();
  });

  const rows = () => [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const rowFor = (path: string) => rows().find((r) => r.dataset.path === path);

  it('exposes exactly one tab stop (roving tabindex)', async () => {
    const stops = rows().filter((r) => r.getAttribute('tabindex') === '0');
    expect(stops.length, 'a tree is a single tab stop, not one per row').to.equal(1);
    expect(stops[0].dataset.path, 'the first row holds it by default').to.equal('notes');
  });

  it('moves focus down and up with the Arrow keys', async () => {
    const first = rowFor('notes')!;
    await act(async () => {
      first.focus();
      press(first, 'ArrowDown');
    });
    expect((document.activeElement as HTMLElement).dataset.path).to.equal('zebra.md');

    await act(async () => press(document.activeElement!, 'ArrowUp'));
    expect((document.activeElement as HTMLElement).dataset.path).to.equal('notes');
  });

  it('moves the tab stop with focus', async () => {
    const first = rowFor('notes')!;
    await act(async () => {
      first.focus();
      press(first, 'ArrowDown');
    });
    const stops = rows().filter((r) => r.getAttribute('tabindex') === '0');
    expect(stops.length).to.equal(1);
    expect(stops[0].dataset.path).to.equal('zebra.md');
  });

  it('expands a folder with ArrowRight, then steps into it', async () => {
    const notes = rowFor('notes')!;
    expect(notes.getAttribute('aria-expanded')).to.equal('false');

    await act(async () => {
      notes.focus();
      press(notes, 'ArrowRight');
    });
    expect(rowFor('notes')!.getAttribute('aria-expanded')).to.equal('true');

    // The children are now rendered, so a second ArrowRight descends.
    await act(async () => press(rowFor('notes')!, 'ArrowRight'));
    expect((document.activeElement as HTMLElement).dataset.path).to.equal('notes/nested.md');
  });

  it('collapses with ArrowLeft, and steps out to the parent from a child', async () => {
    await act(async () => {
      rowFor('notes')!.focus();
      press(rowFor('notes')!, 'ArrowRight');
    });
    await act(async () => press(rowFor('notes')!, 'ArrowRight'));
    expect((document.activeElement as HTMLElement).dataset.path).to.equal('notes/nested.md');

    // From a child, ArrowLeft goes to the parent...
    await act(async () => press(document.activeElement!, 'ArrowLeft'));
    expect((document.activeElement as HTMLElement).dataset.path).to.equal('notes');

    // ...and from the open parent, it closes it.
    await act(async () => press(document.activeElement!, 'ArrowLeft'));
    expect(rowFor('notes')!.getAttribute('aria-expanded')).to.equal('false');
  });

  it('skips the children of a collapsed folder when moving down', async () => {
    const notes = rowFor('notes')!;
    await act(async () => {
      notes.focus();
      press(notes, 'ArrowDown');
    });
    expect((document.activeElement as HTMLElement).dataset.path).to.equal('zebra.md');
  });

  it('walks into an expanded folder when moving down', async () => {
    await act(async () => {
      rowFor('notes')!.focus();
      press(rowFor('notes')!, 'ArrowRight');
    });
    await act(async () => press(rowFor('notes')!, 'ArrowDown'));
    expect((document.activeElement as HTMLElement).dataset.path).to.equal('notes/nested.md');
  });

  it('jumps to the first and last rows with Home and End', async () => {
    const zebra = rowFor('zebra.md')!;
    await act(async () => {
      zebra.focus();
      press(zebra, 'Home');
    });
    expect((document.activeElement as HTMLElement).dataset.path).to.equal('notes');

    await act(async () => press(document.activeElement!, 'End'));
    expect((document.activeElement as HTMLElement).dataset.path).to.equal('zebra.md');
  });

  it('labels the tree', () => {
    const tree = container.querySelector('[role="tree"]');
    expect(tree?.getAttribute('aria-label')).to.equal('Files');
  });
});
