/**
 * The document type last created in a workspace becomes that workspace's
 * default: someone filling a folder with static Web pages keeps getting
 * "Web page — Static" preselected, while other workspaces keep their own
 * choice. The memory is browser-local and per workspace, never written into
 * the folder.
 */
import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryFileSystemProvider } from '@bendyline/docblocks/filesystem';
import {
  DEFAULT_NEW_FILE_FORMAT,
  loadLastNewFileFormat,
  saveLastNewFileFormat,
} from '../src/preferences/new-file-format.js';
import { NewDocumentDialog } from '../src/components/NewDocumentDialog.js';
import { FileExplorer, type NewFileFormat } from '../src/FileExplorer/FileExplorer.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const STORAGE_KEY = 'docblocks:lastNewFileFormat';

function typeInto(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element) as object,
    'value',
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('last new-file type per workspace', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to Markdown and remembers each workspace separately', () => {
    expect(loadLastNewFileFormat('posts')).to.equal(DEFAULT_NEW_FILE_FORMAT);
    expect(loadLastNewFileFormat(null)).to.equal('markdown');
    saveLastNewFileFormat('posts', 'web-static');
    saveLastNewFileFormat('notes', 'docx');
    expect(loadLastNewFileFormat('posts')).to.equal('web-static');
    expect(loadLastNewFileFormat('notes')).to.equal('docx');
    expect(loadLastNewFileFormat('other')).to.equal('markdown');
    saveLastNewFileFormat('posts', 'markdown');
    expect(loadLastNewFileFormat('posts')).to.equal('markdown');
  });

  it('ignores corrupt or unknown stored values', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(loadLastNewFileFormat('posts')).to.equal('markdown');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ posts: 'exe', notes: 'pdf' }));
    expect(loadLastNewFileFormat('posts')).to.equal('markdown');
    expect(loadLastNewFileFormat('notes')).to.equal('pdf');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['web-static']));
    expect(loadLastNewFileFormat('0')).to.equal('markdown');
  });

  it('keeps a bounded number of workspaces, dropping the least recently used', () => {
    for (let index = 0; index < 205; index += 1) saveLastNewFileFormat(`ws-${index}`, 'pdf');
    saveLastNewFileFormat('ws-10', 'docx');
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Record<string, string>;
    expect(Object.keys(stored)).to.have.length(200);
    expect(stored['ws-0']).to.equal(undefined);
    expect(stored['ws-10']).to.equal('docx');
    expect(stored['ws-204']).to.equal('pdf');
  });
});

describe('new-document defaults', () => {
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

  it('preselects the workspace default in the New document dialog', async () => {
    const settled: unknown[] = [];
    await act(async () => {
      root.render(
        createElement(NewDocumentDialog, {
          initialFormat: 'web-static',
          onSettle: (choice) => settled.push(choice),
        }),
      );
    });
    const select = document.querySelector<HTMLSelectElement>('.db-dialog select');
    expect(select?.value).to.equal('web-static');
    const create = [...document.querySelectorAll<HTMLButtonElement>('.db-dialog button')].find(
      (button) => button.textContent === 'Create',
    );
    await act(async () => create?.click());
    expect(settled).to.deep.equal([{ filename: 'Untitled.html', format: 'web-static' }]);
  });

  it('preselects the default in the explorer form and reports the type it used', async function () {
    this.timeout(20_000);
    const provider = new MemoryFileSystemProvider('format-explorer', 'Explorer');
    const used: NewFileFormat[] = [];
    await act(async () => {
      root.render(
        createElement(FileExplorer, {
          provider,
          defaultNewFileFormat: 'web-static',
          onNewFileFormatUsed: (format) => used.push(format),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const newFile = container.querySelector<HTMLButtonElement>('[aria-label="New File"]')!;
    await act(async () => newFile.click());
    const select = container.querySelector<HTMLSelectElement>('.db-new-item-format')!;
    expect(select.value).to.equal('web-static');

    // Switching type for one file is what gets reported, so it becomes the next default.
    await act(async () => {
      select.value = 'docx';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => typeInto(container.querySelector('.db-new-item-input')!, 'Report'));
    await act(async () => {
      container
        .querySelector('.db-new-item-row')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      // Creating a Word document renders it first; wait for the form to settle.
      for (let waited = 0; used.length === 0 && waited < 10_000; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });
    expect(used).to.deep.equal(['docx']);
    expect(await provider.exists('Report.docx')).to.equal(true);
    await provider.v2.dispose();
  });
});
