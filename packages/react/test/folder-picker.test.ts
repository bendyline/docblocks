import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceFolderPicker } from '../src/FolderPicker/WorkspaceFolderPicker.js';
import type {
  FolderChoice,
  WorkspaceFolders,
  WorkspaceFolderSource,
} from '../src/FolderPicker/folder-tree.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ready(paths: readonly string[]): WorkspaceFolders {
  return { status: 'ready', folders: paths.map((path) => ({ path })) };
}

async function renderPicker(
  options: {
    initial?: { workspaceId: string; path: string };
    unavailable?: (choice: FolderChoice) => string | null;
  } = {},
) {
  const work = deferred<WorkspaceFolders>();
  const asked: string[] = [];
  const source: WorkspaceFolderSource = {
    workspaces: [
      { id: 'home', name: 'Home' },
      { id: 'work', name: 'Work' },
    ],
    listFolders(workspaceId) {
      asked.push(workspaceId);
      return workspaceId === 'home' ? ready(['Notes', 'Notes/2026', 'Unfiled']) : work.promise;
    },
  };
  const chosen: FolderChoice[] = [];
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(WorkspaceFolderPicker, {
        label: 'File in…',
        triggerLabel: 'File “Tides” in…',
        source,
        onChoose: (choice: FolderChoice) => chosen.push(choice),
        ...options,
      }),
    );
  });
  const trigger = () => container.querySelector<HTMLButtonElement>('.db-folder-picker-trigger')!;
  const panel = () => document.body.querySelector<HTMLElement>('.db-folder-picker');
  const treeItems = () =>
    Array.from(document.body.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  const rows = () =>
    treeItems().map((row) => row.querySelector('.db-tree-label')?.textContent ?? '');
  const row = (name: string) => {
    const found = treeItems().find(
      (candidate) => candidate.querySelector('.db-tree-label')?.textContent === name,
    );
    if (!found) throw new Error(`No row named ${name}: ${rows().join(', ')}`);
    return found;
  };
  const fire = async (target: Element, event: Event) => {
    await act(async () => {
      target.dispatchEvent(event);
    });
  };
  const click = (target: Element) => fire(target, new MouseEvent('click', { bubbles: true }));
  const key = (target: Element, name: string) =>
    fire(target, new KeyboardEvent('keydown', { key: name, bubbles: true }));
  const openIt = () => click(trigger());
  const type = async (text: string) => {
    const input = document.body.querySelector<HTMLInputElement>('.db-folder-picker-find')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return input;
  };
  const resolveWork = async (paths: readonly string[]) => {
    await act(async () => {
      work.resolve(ready(paths));
      await work.promise;
    });
  };
  const cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return {
    asked,
    chosen,
    trigger,
    panel,
    rows,
    row,
    fire,
    click,
    key,
    openIt,
    type,
    resolveWork,
    cleanup,
  };
}

describe('WorkspaceFolderPicker', () => {
  it('drops down every workspace open, reading the others as it opens', async () => {
    const picker = await renderPicker();
    try {
      expect(picker.panel()).to.equal(null);
      expect(picker.asked).to.eql([]);
      await picker.openIt();
      expect(picker.trigger().getAttribute('aria-expanded')).to.equal('true');
      expect(picker.asked).to.eql(['home', 'work']);
      expect(picker.rows()).to.eql(['Home', 'Notes', 'Unfiled', 'Work']);
      expect(picker.row('Work').textContent).to.contain('Looking…');
      await picker.resolveWork(['Clients', 'Clients/Acme']);
      expect(picker.rows()).to.eql(['Home', 'Notes', 'Unfiled', 'Work', 'Clients']);
      expect(document.activeElement?.className).to.equal('db-folder-picker-find');
    } finally {
      await picker.cleanup();
    }
  });

  it('chooses a folder with one click, and opens one with its chevron without choosing', async () => {
    const picker = await renderPicker();
    try {
      await picker.openIt();
      await picker.click(picker.row('Notes').querySelector('.db-folder-picker-disclosure')!);
      expect(picker.rows()).to.eql(['Home', 'Notes', '2026', 'Unfiled', 'Work']);
      expect(picker.chosen).to.eql([]);

      await picker.click(picker.row('2026'));
      expect(picker.chosen).to.eql([
        { workspaceId: 'home', workspaceName: 'Home', path: 'Notes/2026' },
      ]);
      expect(picker.panel()).to.equal(null);
      expect(document.activeElement).to.equal(picker.trigger());

      // A workspace's own row is its top.
      await picker.openIt();
      await picker.click(picker.row('Home'));
      expect(picker.chosen[1]).to.eql({ workspaceId: 'home', workspaceName: 'Home', path: '' });
    } finally {
      await picker.cleanup();
    }
  });

  it('will not choose a folder it is told is unavailable, and says why', async () => {
    const picker = await renderPicker({
      unavailable: (choice) => (choice.path === 'Unfiled' ? "It's already in Unfiled." : null),
    });
    try {
      await picker.openIt();
      const unfiled = picker.row('Unfiled');
      expect(unfiled.getAttribute('aria-disabled')).to.equal('true');
      expect(unfiled.title).to.equal("It's already in Unfiled.");
      await picker.click(unfiled);
      await picker.key(unfiled, 'Enter');
      expect(picker.chosen).to.eql([]);
      expect(picker.panel()).not.to.equal(null);
    } finally {
      await picker.cleanup();
    }
  });

  it('moves with the arrow keys, opens folders, chooses on Enter, and closes on Escape', async () => {
    const picker = await renderPicker();
    try {
      await picker.openIt();
      const find = document.body.querySelector<HTMLInputElement>('.db-folder-picker-find')!;
      await picker.key(find, 'ArrowDown');
      expect(document.activeElement).to.equal(picker.row('Home'));
      await picker.key(picker.row('Home'), 'ArrowDown');
      expect(document.activeElement).to.equal(picker.row('Notes'));
      await picker.key(picker.row('Notes'), 'ArrowRight');
      await picker.key(picker.row('Notes'), 'ArrowDown');
      expect(document.activeElement).to.equal(picker.row('2026'));
      await picker.key(picker.row('2026'), 'Escape');
      expect(picker.panel()).to.equal(null);
      expect(picker.chosen).to.eql([]);
      expect(document.activeElement).to.equal(picker.trigger());

      // Opened again, it is a new field.
      await picker.openIt();
      await picker.key(document.body.querySelector('.db-folder-picker-find')!, 'ArrowDown');
      await picker.key(document.activeElement!, 'ArrowDown');
      await picker.key(document.activeElement!, 'Enter');
      expect(picker.chosen).to.eql([{ workspaceId: 'home', workspaceName: 'Home', path: 'Notes' }]);
    } finally {
      await picker.cleanup();
    }
  });

  it('puts itself away when something else is pressed', async () => {
    const picker = await renderPicker();
    try {
      await picker.openIt();
      await picker.fire(document.body, new MouseEvent('pointerdown', { bubbles: true }));
      expect(picker.panel()).to.equal(null);
      expect(picker.chosen).to.eql([]);
    } finally {
      await picker.cleanup();
    }
  });

  it('finds a folder by name in every workspace, and Enter takes the first one found', async () => {
    const picker = await renderPicker();
    try {
      await picker.openIt();
      const find = await picker.type('acm');
      expect(picker.rows()).to.eql(['Work']);
      await picker.resolveWork(['Clients/Acme', 'Clients/Bolt']);
      expect(picker.rows()).to.eql(['Work', 'Clients', 'Acme']);
      expect(picker.row('Acme').querySelector('mark')?.textContent).to.equal('Acm');
      await picker.key(find, 'Enter');
      expect(picker.chosen).to.eql([
        { workspaceId: 'work', workspaceName: 'Work', path: 'Clients/Acme' },
      ]);

      await picker.openIt();
      await picker.type('nothing like it');
      expect(document.body.textContent).to.contain('No folder is called “nothing like it”.');
    } finally {
      await picker.cleanup();
    }
  });

  it('starts on a suggested folder, with the folders above it open', async () => {
    const picker = await renderPicker({ initial: { workspaceId: 'home', path: 'Notes/2026' } });
    try {
      await picker.openIt();
      expect(picker.rows()).to.eql(['Home', 'Notes', '2026', 'Unfiled', 'Work']);
      expect(picker.row('2026').textContent).to.contain('Suggested');
      expect(picker.row('2026').tabIndex).to.equal(0);
    } finally {
      await picker.cleanup();
    }
  });
});
