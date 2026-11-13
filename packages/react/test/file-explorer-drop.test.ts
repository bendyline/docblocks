import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryFileSystemProvider } from '@bendyline/docblocks/filesystem';
import { FileExplorer } from '../src/FileExplorer/FileExplorer.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe('FileExplorer external drops', () => {
  it('forwards both supported and rejected files so the importer can report each one', async () => {
    const provider = new MemoryFileSystemProvider('drop-test', 'Drop test');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let received: File[] = [];

    try {
      await act(async () => {
        root.render(
          createElement(FileExplorer, {
            provider,
            onImportFiles: (files) => {
              received = files;
            },
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      const csv = new File(['A,B\n1,2\n'], 'table.csv', { type: 'text/csv' });
      const image = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
      const rejected = new File([new Uint8Array([77, 90])], 'tool.exe', {
        type: 'application/x-msdownload',
      });
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { files: [csv, image, rejected], items: [], types: ['Files'], dropEffect: 'none' },
      });

      await act(async () => {
        container.querySelector('.db-file-explorer')?.dispatchEvent(event);
      });

      expect(received.map((file) => file.name)).to.deep.equal([
        'table.csv',
        'photo.png',
        'tool.exe',
      ]);

      received = [];
      const rejectedOnlyDragOver = new Event('dragover', { bubbles: true, cancelable: true });
      Object.defineProperty(rejectedOnlyDragOver, 'dataTransfer', {
        value: { files: [rejected], items: [], types: ['Files'], dropEffect: 'none' },
      });
      container.querySelector('.db-file-explorer')?.dispatchEvent(rejectedOnlyDragOver);
      expect(rejectedOnlyDragOver.defaultPrevented).to.equal(true);

      const rejectedOnlyDrop = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(rejectedOnlyDrop, 'dataTransfer', {
        value: { files: [rejected], items: [], types: ['Files'], dropEffect: 'none' },
      });
      await act(async () => {
        container.querySelector('.db-file-explorer')?.dispatchEvent(rejectedOnlyDrop);
      });
      expect(received.map((file) => file.name)).to.deep.equal(['tool.exe']);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await provider.v2.dispose();
    }
  });

  it('offers an Import files button that sends picked files to the same importer', async () => {
    const provider = new MemoryFileSystemProvider('import-test', 'Import test');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let received: File[] = [];

    try {
      await act(async () => {
        root.render(
          createElement(FileExplorer, {
            provider,
            onImportFiles: (files) => {
              received = files;
            },
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Import files"]',
      );
      const input = container.querySelector<HTMLInputElement>(
        'input[type="file"][aria-label="Choose files to import"]',
      );
      expect(button, 'Import files button').to.not.equal(null);
      expect(input?.multiple).to.equal(true);
      expect(input?.accept).to.contain('.docx');

      let opened = false;
      input?.addEventListener('click', (event) => {
        opened = true;
        event.preventDefault();
      });
      await act(async () => button?.click());
      expect(opened, 'button opens the file picker').to.equal(true);

      const docx = new File(['PK'], 'plan.docx');
      Object.defineProperty(input, 'files', { value: [docx], configurable: true });
      await act(async () => {
        input?.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(received.map((file) => file.name)).to.deep.equal(['plan.docx']);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await provider.v2.dispose();
    }
  });

  it('has no Import files button when the host cannot import', async () => {
    const provider = new MemoryFileSystemProvider('no-import', 'No import');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(FileExplorer, { provider }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(container.querySelector('button[aria-label="Import files"]')).to.equal(null);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await provider.v2.dispose();
    }
  });
});
