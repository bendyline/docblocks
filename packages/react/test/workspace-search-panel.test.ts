import { expect } from 'chai';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryFileSystemProviderV2, parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import { createWorkspaceIndex, type WorkspaceIndex } from '@bendyline/docblocks/workspace-index';
import {
  WorkspaceSearchPanel,
  type WorkspaceSearchOpenRequest,
} from '../src/WorkspaceSearch/WorkspaceSearchPanel.js';

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

async function settle(ms = 300): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function analyzedIndex(files: Record<string, string>): Promise<WorkspaceIndex> {
  const provider = new MemoryFileSystemProviderV2('search-panel', 'Search panel');
  for (const [path, text] of Object.entries(files)) {
    await provider.writeFile(parseWorkspacePath(path), new TextEncoder().encode(text), {
      createParents: true,
    });
  }
  const index = createWorkspaceIndex({ workspaceId: 'ws', source: provider });
  index.start();
  for (let attempt = 0; attempt < 200 && index.getStatus().phase !== 'ready'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return index;
}

describe('WorkspaceSearchPanel', () => {
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

  async function render(
    index: WorkspaceIndex,
    opened: WorkspaceSearchOpenRequest[],
    hidden = false,
  ) {
    await act(async () => {
      root.render(
        createElement(WorkspaceSearchPanel, {
          index,
          status: index.getStatus(),
          hidden,
          focusRequest: 1,
          onOpen: (request: WorkspaceSearchOpenRequest) => opened.push(request),
          onShowFiles: () => undefined,
        }),
      );
    });
  }

  it('groups highlighted line matches by document and opens the chosen line', async () => {
    const index = await analyzedIndex({
      'alpha.md': '# Alpha\n\nThe Needle is here.\n\nAnother needle.\n',
      'beta.md': '# Beta\n\nNo match.\n',
    });
    const opened: WorkspaceSearchOpenRequest[] = [];
    await render(index, opened);

    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(document.activeElement).to.equal(input);
    await act(async () => typeInto(input, 'needle'));
    await settle();

    const documents = container.querySelectorAll('.db-search-document');
    expect(documents).to.have.length(1);
    expect(documents[0]!.getAttribute('aria-expanded')).to.equal('true');
    const lines = [...container.querySelectorAll<HTMLElement>('.db-search-line')];
    expect(lines.map((line) => line.querySelector('mark')?.textContent)).to.deep.equal([
      'Needle',
      'needle',
    ]);
    expect(container.querySelector('[role="status"]')?.textContent).to.contain(
      '2 results in 1 document',
    );

    await act(async () => lines[1]!.click());
    expect(opened).to.have.length(1);
    expect(opened[0]!.path).to.equal('alpha.md');
    expect(opened[0]!.match?.line).to.equal(5);
    expect(opened[0]!.query).to.equal('needle');
    index.dispose();
  });

  it('narrows with Match case and keeps results while hidden', async () => {
    const index = await analyzedIndex({ 'alpha.md': 'Needle needle NEEDLE\n' });
    const opened: WorkspaceSearchOpenRequest[] = [];
    await render(index, opened);
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => typeInto(input, 'needle'));
    await settle();
    expect(container.querySelector('.db-search-count')?.textContent).to.equal('3');

    const matchCase = container.querySelector<HTMLButtonElement>('[aria-label="Match case"]')!;
    await act(async () => matchCase.click());
    await settle();
    expect(matchCase.getAttribute('aria-pressed')).to.equal('true');
    expect(container.querySelector('.db-search-count')?.textContent).to.equal('1');

    await render(index, opened, true);
    const panel = container.querySelector<HTMLElement>('.db-search-panel')!;
    expect(panel.hidden).to.equal(true);
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')!.value).to.equal(
      'needle',
    );
    index.dispose();
  });

  it('collapses and expands a document from the keyboard', async () => {
    const index = await analyzedIndex({ 'alpha.md': 'one needle\n\ntwo needle\n' });
    await render(index, []);
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => typeInto(input, 'needle'));
    await settle();

    const tree = container.querySelector<HTMLElement>('[role="tree"]')!;
    const documentRow = container.querySelector<HTMLElement>('.db-search-document')!;
    expect(documentRow.tabIndex).to.equal(0);
    await act(async () => {
      tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(container.querySelectorAll('.db-search-line')).to.have.length(0);
    expect(documentRow.getAttribute('aria-expanded')).to.equal('false');
    await act(async () => {
      tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(container.querySelectorAll('.db-search-line')).to.have.length(2);
    index.dispose();
  });

  it('does not offer old matches while a changed query is debouncing', async () => {
    const index = await analyzedIndex({ 'alpha.md': 'needle\n' });
    try {
      await render(index, []);
      const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
      await act(async () => typeInto(input, 'needle'));
      await settle();
      expect(container.querySelectorAll('.db-search-document')).to.have.length(1);

      await act(async () => typeInto(input, 'something else'));
      expect(container.querySelectorAll('.db-search-document')).to.have.length(0);
      expect(container.querySelector('[role="status"]')?.textContent).to.equal('Searching…');
      await settle();
      expect(container.querySelector('[role="status"]')?.textContent).to.equal('No results.');
    } finally {
      index.dispose();
    }
  });

  it('clears matches from the previous workspace before searching the new one', async () => {
    const first = await analyzedIndex({ 'alpha.md': 'needle\n' });
    const second = await analyzedIndex({ 'beta.md': 'needle\n' });
    try {
      await render(first, []);
      const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
      await act(async () => typeInto(input, 'needle'));
      await settle();
      expect(container.querySelectorAll('.db-search-document')).to.have.length(1);

      await render(second, []);
      expect(container.querySelectorAll('.db-search-document')).to.have.length(0);
      await settle();
      expect(container.querySelector('.db-search-document')?.textContent).to.include('beta');
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});
