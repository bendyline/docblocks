import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorProvider } from '@bendyline/squisq-editor-react';
import {
  ExportToolbarControls,
  type ExportDestinationAdapter,
} from '../src/Export/ExportToolbarControls.js';
import { DEFAULT_OPTIONS, saveExportOptions } from '../src/Export/export-options.js';
import { loadOpenAfterExport, saveOpenAfterExport } from '../src/preferences/export.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function button(text: string) {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
}
function checkbox() {
  return document.querySelector<HTMLInputElement>('.db-export-open-after-save input');
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error('Export UI did not settle');
}

describe('open after export', () => {
  let root: Root;
  let container: HTMLElement;
  let calls: string[];
  let adapter: ExportDestinationAdapter;
  const saved = { grantId: 'saved-grant', displayPath: '/saved/report.md' };

  beforeEach(() => {
    localStorage.clear();
    saveExportOptions({ ...DEFAULT_OPTIONS, format: 'md' });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    calls = [];
    adapter = {
      resolveTarget: async () => ({ grantId: 'suggested', displayPath: '/report.md' }),
      pickTarget: async () => saved,
      saveBlob: async () => {
        calls.push('save');
        return saved;
      },
      openSaved: async (target) => {
        expect(target).to.equal(saved);
        calls.push('open');
      },
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
  });

  async function mount(trigger: 'button' | 'menu' = 'button') {
    await act(async () => {
      root.render(
        createElement(
          EditorProvider,
          { initialMarkdown: '# Report\n' },
          createElement(ExportToolbarControls, {
            selectedFile: '/report.md',
            trigger,
            showVideoExport: false,
            destinationAdapter: adapter,
          }),
        ),
      );
    });
  }
  async function openDialog() {
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Export document"]')!.click(),
    );
    await until(() => !!button('Save MD'));
  }

  it('defaults off, sits above Save, and remembers both choices across remounts', async () => {
    await mount();
    await openDialog();
    expect(checkbox()?.checked).to.equal(false);
    expect(
      checkbox()!.compareDocumentPosition(button('Save MD')!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.to.equal(0);
    await act(async () => checkbox()!.click());
    expect(loadOpenAfterExport()).to.equal(true);
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    await openDialog();
    expect(checkbox()?.checked).to.equal(true);
    await act(async () => checkbox()!.click());
    expect(loadOpenAfterExport()).to.equal(false);
    await act(async () => button('Save MD')!.click());
    await until(() => !document.querySelector('.db-export-dialog'));
    expect(calls).to.deep.equal(['save']);
  });

  it('opens exactly the successful save result after writing', async () => {
    saveOpenAfterExport(true);
    await mount();
    await openDialog();
    await act(async () => button('Save MD')!.click());
    await until(() => calls.includes('open'));
    expect(calls).to.deep.equal(['save', 'open']);
    expect(document.querySelector('.db-export-dialog')).to.equal(null);
  });

  it('confirms the saved path and opens that result on request without exporting again', async () => {
    await mount();
    await openDialog();
    await act(async () => button('Save MD')!.click());
    await until(() => !!button('Open exported file'));
    expect(document.querySelector('.db-export-completion')?.textContent).to.include(
      'Saved /saved/report.md',
    );
    expect(calls).to.deep.equal(['save']);
    await act(async () => button('Open exported file')!.click());
    expect(calls).to.deep.equal(['save', 'open']);
    expect(loadOpenAfterExport()).to.equal(false);
    await act(async () => button('Dismiss')!.click());
    expect(document.querySelector('.db-export-completion')).to.equal(null);
  });

  for (const outcome of ['cancelled', 'failed'] as const) {
    it(`never opens a ${outcome} save`, async () => {
      saveOpenAfterExport(true);
      adapter.saveBlob = async () => {
        calls.push('save');
        if (outcome === 'failed') throw new Error('Disk is full');
        return null;
      };
      await mount();
      await openDialog();
      await act(async () => button('Save MD')!.click());
      await until(() => calls.length > 0 && !button('Save MD')?.disabled);
      expect(calls).to.deep.equal(['save']);
      expect(document.querySelector('.db-export-dialog')).not.to.equal(null);
      expect(document.querySelector('.db-export-completion')).to.equal(null);
    });
  }

  it('reports an open failure as a saved file, without retrying the export', async () => {
    saveOpenAfterExport(true);
    adapter.openSaved = async () => {
      calls.push('open');
      throw new Error('No associated app');
    };
    await mount();
    await openDialog();
    await act(async () => button('Save MD')!.click());
    await until(
      () =>
        document.body.textContent?.includes("The file was saved, but it couldn't be opened.") ===
        true,
    );
    expect(document.body.textContent).to.include('No associated app');
    expect(document.body.textContent).not.to.include('Export failed');
    expect(document.querySelector('.db-export-dialog')).to.equal(null);
    expect(calls).to.deep.equal(['save', 'open']);
  });

  it('hides the option when the host cannot open files', async () => {
    delete adapter.openSaved;
    await mount();
    await openDialog();
    expect(checkbox()).to.equal(null);
  });

  it('applies the sticky preference to quick export', async () => {
    saveOpenAfterExport(true);
    await mount('menu');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Export and share"]')!.click(),
    );
    await until(() => !!document.querySelector<HTMLButtonElement>('[role="menuitem"][title]'));
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[role="menuitem"][title]')!.click(),
    );
    await until(() => calls.includes('open'));
    expect(calls).to.deep.equal(['save', 'open']);
  });
});
