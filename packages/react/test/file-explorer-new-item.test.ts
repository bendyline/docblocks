/**
 * Creating a file/folder must not fail silently (SF-7).
 *
 * The form called an async submit un-awaited with no catch, and
 * useFileTree.createFile uses `mode: 'create'`, which rejects with
 * already-exists on a duplicate name. The input just sat there looking
 * idle while the rejection went to the console.
 *
 * The explorer already has a convention for this — handleRename surfaces
 * through a styled `.db-tree-error` with role="alert" — so that is what
 * the new-item form reuses.
 */
import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryFileSystemProvider, parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import { FileExplorer } from '../src/FileExplorer/FileExplorer.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
// Supply the classic JSX runtime expected by its direct source transform.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

/** Write through the prototype setter so React's value tracker sees a change. */
function typeInto(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element) as object,
    'value',
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function createDeferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

describe('FileExplorer new item failures', () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let provider: MemoryFileSystemProvider;

  beforeEach(async () => {
    provider = new MemoryFileSystemProvider('mem', 'Memory');
    await provider.v2.writeFile(
      parseWorkspacePath('taken.md'),
      new TextEncoder().encode('# Taken'),
      { mode: 'create' },
    );
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

  /** Open the New File form and submit `name`. */
  async function submitNewFile(name: string): Promise<void> {
    const newFile = container.querySelector<HTMLButtonElement>('[aria-label="New File"]');
    if (!newFile) throw new Error('New File button missing');
    await act(async () => newFile.click());
    const input = container.querySelector<HTMLInputElement>('.db-new-item-input');
    if (!input) throw new Error('new item input missing');
    await act(async () => typeInto(input, name));
    const form = container.querySelector<HTMLFormElement>('.db-new-item-row');
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }

  it('surfaces a duplicate name instead of sitting there silently', async () => {
    await submitNewFile('taken');

    const alert = container.querySelector('[role="alert"]');
    expect(alert, 'a failed create must be surfaced').to.not.equal(null);
    expect(alert?.textContent).to.include('exists');
  });

  it('keeps the form open with the typed name so it can be corrected', async () => {
    await submitNewFile('taken');

    const input = container.querySelector<HTMLInputElement>('.db-new-item-input');
    expect(input, 'the form must stay open after a failure').to.not.equal(null);
    expect(input?.value, 'the typed name must survive so it can be edited').to.equal('taken');
    expect(input?.getAttribute('aria-invalid')).to.equal('true');
  });

  it('clears the error once the name is edited', async () => {
    await submitNewFile('taken');
    expect(container.querySelector('[role="alert"]')).to.not.equal(null);

    const input = container.querySelector<HTMLInputElement>('.db-new-item-input');
    await act(async () => typeInto(input!, 'untaken'));

    expect(
      container.querySelector('[role="alert"]'),
      'the complaint no longer applies to the new name',
    ).to.equal(null);
    expect(input?.getAttribute('aria-invalid')).to.equal('false');
  });

  it('keeps creation single-flight while the provider write is pending', async () => {
    const writeStarted = createDeferred();
    const releaseWrite = createDeferred();
    const writeFile = provider.v2.writeFile.bind(provider.v2);
    let writeCount = 0;
    provider.v2.writeFile = async (...parameters: Parameters<typeof writeFile>) => {
      writeCount += 1;
      writeStarted.resolve();
      await releaseWrite.promise;
      return writeFile(...parameters);
    };

    const newFile = container.querySelector<HTMLButtonElement>('[aria-label="New File"]');
    const newFolder = container.querySelector<HTMLButtonElement>('[aria-label="New Folder"]');
    if (!newFile || !newFolder) throw new Error('new-item toolbar buttons missing');
    await act(async () => newFile.click());

    const input = container.querySelector<HTMLInputElement>('.db-new-item-input');
    const form = container.querySelector<HTMLFormElement>('.db-new-item-row');
    if (!input || !form) throw new Error('new-file form missing');
    await act(async () => typeInto(input, 'delayed'));
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await writeStarted.promise;

    const add = container.querySelector<HTMLButtonElement>('.db-new-item-add');
    expect(newFile.disabled).to.equal(true);
    expect(newFolder.disabled).to.equal(true);
    expect(input.disabled).to.equal(true);
    expect(add?.disabled).to.equal(true);
    expect(form.getAttribute('aria-busy')).to.equal('true');

    await act(async () => {
      add?.click();
      newFolder.click();
    });
    expect(writeCount, 'a pending submit cannot be duplicated').to.equal(1);
    expect(
      container.querySelector<HTMLInputElement>('.db-new-item-input')?.getAttribute('aria-label'),
      'a pending file creation cannot be replaced by a folder form',
    ).to.equal('New file name');

    await act(async () => {
      releaseWrite.resolve();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(newFolder.disabled).to.equal(false);
    expect(container.querySelector('.db-new-item-input')).to.equal(null);
    const rows = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    expect(rows.map((row) => row.dataset.path)).to.include('delayed.md');

    await act(async () => newFolder.click());
    expect(
      container.querySelector<HTMLInputElement>('.db-new-item-input')?.getAttribute('aria-label'),
    ).to.equal('New folder name');
  });

  it('closes the form and creates the file when the name is free', async () => {
    await submitNewFile('fresh');

    expect(container.querySelector('[role="alert"]')).to.equal(null);
    expect(container.querySelector('.db-new-item-input'), 'a success closes the form').to.equal(
      null,
    );
    const rows = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    expect(rows.map((row) => row.dataset.path)).to.include('fresh.md');
  });

  it('recovers: a corrected name creates after a failure', async () => {
    await submitNewFile('taken');
    const input = container.querySelector<HTMLInputElement>('.db-new-item-input');
    await act(async () => typeInto(input!, 'corrected'));
    const form = container.querySelector<HTMLFormElement>('.db-new-item-row');
    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(container.querySelector('.db-new-item-input')).to.equal(null);
    const rows = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    expect(rows.map((row) => row.dataset.path)).to.include('corrected.md');
  });
});
