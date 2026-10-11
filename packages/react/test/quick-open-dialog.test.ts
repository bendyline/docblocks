import { expect } from 'chai';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryFileSystemProviderV2, parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import { createWorkspaceIndex, type WorkspaceIndex } from '@bendyline/docblocks/workspace-index';
import { QuickOpenDialog } from '../src/QuickOpen/QuickOpenDialog.js';
import type { QuickOpenItem } from '../src/QuickOpen/quick-open-ranking.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

function typeInto(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element) as object,
    'value',
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

async function readyIndex(paths: readonly string[]): Promise<WorkspaceIndex> {
  const provider = new MemoryFileSystemProviderV2('quick-open', 'Quick open');
  for (const path of paths) {
    // Titles match the file names, so rows read the same before and after analysis.
    const stem = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/u, '');
    await provider.writeFile(parseWorkspacePath(path), new TextEncoder().encode(`# ${stem}\n`), {
      createParents: true,
    });
  }
  const index = createWorkspaceIndex({ workspaceId: 'ws', source: provider });
  index.start();
  while (index.getStatus().phase !== 'ready') {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return index;
}

describe('QuickOpenDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('filters as you type and opens the active option with Enter', async () => {
    const index = await readyIndex(['alpha.md', 'beta.md', 'notes/gamma.md']);
    const opened: QuickOpenItem[] = [];
    await act(async () => {
      root.render(
        createElement(QuickOpenDialog, {
          index,
          status: index.getStatus(),
          workspaceId: 'ws',
          activePath: null,
          recent: [],
          pins: [],
          focusRequest: 1,
          onOpen: (item: QuickOpenItem) => opened.push(item),
          onClose: () => undefined,
        }),
      );
    });

    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    const listbox = container.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(document.activeElement).to.equal(input);
    expect(input.getAttribute('aria-controls')).to.equal(listbox.id);
    expect(container.querySelector('.db-visually-hidden')?.textContent).to.equal('Go to document');

    await act(async () => typeInto(input, 'gam'));
    const options = container.querySelectorAll<HTMLElement>('[role="option"]');
    expect([...options].map((option) => option.textContent)).to.deep.equal(['gammanotes']);
    expect(options[0]!.querySelector('mark')?.textContent).to.equal('gam');
    expect(input.getAttribute('aria-activedescendant')).to.equal(options[0]!.id);

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(opened.map((item) => item.path)).to.deep.equal(['notes/gamma.md']);
    index.dispose();
  });

  it('moves the active option with the arrow keys', async () => {
    const index = await readyIndex(['a.md', 'b.md', 'c.md']);
    await act(async () => {
      root.render(
        createElement(QuickOpenDialog, {
          index,
          status: index.getStatus(),
          workspaceId: 'ws',
          activePath: null,
          recent: [],
          pins: [],
          focusRequest: 1,
          onOpen: () => undefined,
          onClose: () => undefined,
        }),
      );
    });
    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    const options = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options()).to.have.length(3);
    expect(options()[0]!.getAttribute('aria-selected')).to.equal('true');

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(options()[1]!.getAttribute('aria-selected')).to.equal('true');
    expect(input.getAttribute('aria-activedescendant')).to.equal(options()[1]!.id);

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(options()[0]!.getAttribute('aria-selected')).to.equal('true');
    index.dispose();
  });
});
