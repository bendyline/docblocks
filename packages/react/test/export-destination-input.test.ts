import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ExportDialog } from '../src/Export/ExportDialog.js';
import { DEFAULT_OPTIONS } from '../src/Export/export-options.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe('ExportDialog destination input', () => {
  it('allows host-validated edits and blocks export while they are invalid', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const edits: string[] = [];

    try {
      await act(async () => {
        root.render(
          createElement(ExportDialog, {
            initial: DEFAULT_OPTIONS,
            exporting: false,
            destination: {
              value: 'C:\\Exports\\document.pdf',
              onChange: (value) => edits.push(value),
              onPick: () => undefined,
              error: 'The file name must end in .pdf.',
            },
            onExport: () => undefined,
            onClose: () => undefined,
          }),
        );
      });

      const input = container.querySelector<HTMLInputElement>('#db-export-path');
      expect(input?.readOnly).to.equal(false);
      expect(input?.getAttribute('aria-invalid')).to.equal('true');

      await act(async () => {
        if (!input) return;
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setValue?.call(input, 'C:\\Exports\\renamed.pdf');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(edits).to.deep.equal(['C:\\Exports\\renamed.pdf']);

      const exportButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === 'Export',
      );
      expect(exportButton?.disabled).to.equal(true);
      expect(container.querySelector('[role="alert"]')?.textContent).to.include('.pdf');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
