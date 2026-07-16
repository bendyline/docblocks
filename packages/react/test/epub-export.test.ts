import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ExportDialog } from '../src/Export/ExportDialog.js';
import { DEFAULT_OPTIONS } from '../src/Export/export-options.js';
import { runExport } from '../src/Export/run-export.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe('EPUB export', () => {
  it('produces an EPUB 3 download through the shared browser pipeline', async () => {
    const saved: { blob: Blob; filename: string }[] = [];

    await runExport(
      '---\ntitle: Field Guide\nauthor: DocBlocks\n---\n\n# First chapter\n\nHello.\n',
      '/field-guide.md',
      { ...DEFAULT_OPTIONS, format: 'epub' },
      null,
      (blob, filename) => {
        saved.push({ blob, filename });
      },
    );

    const result = saved[0];
    expect(result).not.to.equal(undefined);
    if (!result) throw new Error('EPUB export did not save a result');
    expect(result.filename).to.equal('field-guide.epub');
    expect(result.blob.type).to.equal('application/epub+zip');

    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    expect([...bytes.slice(0, 2)]).to.deep.equal([0x50, 0x4b]);
    expect(new TextDecoder().decode(bytes)).to.include('application/epub+zip');
  });

  it('offers EPUB in the built-in dialog and keeps theme selection available', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const exported: string[] = [];

    try {
      await act(async () => {
        root.render(
          createElement(ExportDialog, {
            initial: DEFAULT_OPTIONS,
            exporting: false,
            onExport: (options) => exported.push(options.format),
            onClose: () => undefined,
          }),
        );
      });

      const epub = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
        (button) => button.textContent?.trim() === 'EPUB',
      );
      expect(epub).not.to.equal(undefined);
      await act(async () => epub!.click());

      expect(container.querySelector<HTMLSelectElement>('#db-export-theme')).not.to.equal(null);
      const confirm = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === 'Export',
      );
      await act(async () => confirm!.click());
      expect(exported).to.deep.equal(['epub']);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
