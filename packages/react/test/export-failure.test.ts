/**
 * A failed export must never look like a successful one.
 *
 * The dialog used to close from a `finally` with no `catch`, so a rejected
 * `runExport` (bad image, converter failure, destination write refused)
 * dismissed the dialog and left an unhandled rejection — the user walked
 * away believing the file had been written.
 *
 * These drive the real pipeline and fail it the way a host does: a
 * `saveBlob` that rejects.
 */
import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorProvider } from '@bendyline/squisq-editor-react';
import { ExportToolbarControls } from '../src/Export/ExportToolbarControls.js';
import { ExportDialog } from '../src/Export/ExportDialog.js';
import { DEFAULT_OPTIONS } from '../src/Export/export-options.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
// Supply the classic JSX runtime expected by its direct source transform.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const SAVE_FAILURE = 'The destination folder is read-only.';

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text,
  );
}

/** Poll until `check` passes — lazy chunks and the export pipeline settle async. */
async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe('Export failure surfacing', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    window.localStorage.clear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.clear();
  });

  async function openDialogAndExport(): Promise<void> {
    await act(async () => {
      root.render(
        createElement(
          EditorProvider,
          { initialMarkdown: '# Export me\n\nSome prose.\n' },
          createElement(ExportToolbarControls, {
            selectedFile: '/notes/draft.md',
            trigger: 'button',
            showVideoExport: false,
            saveBlob: async () => {
              throw new Error(SAVE_FAILURE);
            },
          }),
        ),
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Export document"]');
    expect(trigger, 'export trigger').not.to.equal(null);
    await act(async () => trigger!.click());

    // ExportDialog is lazy.
    await waitFor(
      () => buttonByText(document.body, 'Save PDF to Downloads') !== undefined,
      'the export dialog',
    );

    // Markdown is the cheapest pipeline that still round-trips through
    // the real converter and the failing saveBlob.
    const markdownChip = buttonByText(document.body, 'Markdown');
    expect(markdownChip, 'markdown format chip').not.to.equal(undefined);
    await act(async () => markdownChip!.click());

    await act(async () => buttonByText(document.body, 'Save MD to Downloads')!.click());
    await waitFor(
      () => document.body.textContent?.includes(SAVE_FAILURE) === true,
      'the export failure to be surfaced',
    );
  }

  it('keeps the dialog open and shows the reason when the export fails', async () => {
    await openDialogAndExport();

    const alert = document.body.querySelector('[role="alert"]');
    expect(alert, 'the failure must be announced').not.to.equal(null);
    expect(alert?.textContent).to.include(SAVE_FAILURE);
    expect(alert?.textContent).to.include('Export failed');

    // The dialog must not have closed as if the export had worked.
    expect(document.body.querySelector('.db-export-dialog'), 'dialog stays open').not.to.equal(
      null,
    );
    // ...and the user can retry rather than being stuck.
    expect(buttonByText(document.body, 'Save MD to Downloads')?.disabled).to.equal(false);
  });

  it('gives a failed quick export its own dialog', async () => {
    // Quick export runs straight from the overflow menu with no dialog
    // open, so its failure had nowhere at all to surface.
    window.localStorage.setItem(
      'docblocks-export-options',
      JSON.stringify({ ...DEFAULT_OPTIONS, format: 'md' }),
    );

    await act(async () => {
      root.render(
        createElement(
          EditorProvider,
          { initialMarkdown: '# Export me\n' },
          createElement(ExportToolbarControls, {
            selectedFile: '/notes/draft.md',
            showVideoExport: false,
            saveBlob: async () => {
              throw new Error(SAVE_FAILURE);
            },
          }),
        ),
      );
    });

    const menu = container.querySelector<HTMLButtonElement>('[aria-label="Export and share"]');
    expect(menu, 'export menu trigger').not.to.equal(null);
    await act(async () => menu!.click());

    const quick = buttonByText(document.body, 'Save MD to Downloads');
    expect(quick, 'quick export item').not.to.equal(undefined);
    await act(async () => quick!.click());

    await waitFor(
      () => document.body.textContent?.includes(SAVE_FAILURE) === true,
      'the quick-export failure to be surfaced',
    );
    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).to.include('Export failed');
    expect(document.body.querySelector('[role="dialog"]'), 'a dialog carries it').not.to.equal(
      null,
    );

    await act(async () => buttonByText(document.body, 'Close')!.click());
    expect(document.body.textContent).to.not.include(SAVE_FAILURE);
  });

  it('shows the resolved native destination in the quick-export item', async () => {
    const displayPath = 'C:\\Users\\party\\Desktop\\resume4.docx';
    const resolvedFilenames: string[] = [];
    window.localStorage.setItem(
      'docblocks-export-options',
      JSON.stringify({ ...DEFAULT_OPTIONS, format: 'docx' }),
    );

    await act(async () => {
      root.render(
        createElement(
          EditorProvider,
          { initialMarkdown: '# Export me\n' },
          createElement(ExportToolbarControls, {
            selectedFile: '/notes/resume4.md',
            showVideoExport: false,
            destinationAdapter: {
              resolveTarget: async (filename) => {
                resolvedFilenames.push(filename);
                return { grantId: 'export-grant', displayPath };
              },
              pickTarget: async () => null,
              saveBlob: async () => ({ grantId: 'export-grant', displayPath }),
            },
          }),
        ),
      );
    });

    const menu = container.querySelector<HTMLButtonElement>('[aria-label="Export and share"]');
    await act(async () => menu!.click());
    const expectedLabel = `Save DOCX to ${displayPath}`;
    await waitFor(
      () => buttonByText(document.body, expectedLabel) !== undefined,
      'the quick-export destination',
    );

    const quick = buttonByText(document.body, expectedLabel);
    expect(quick?.disabled).to.equal(false);
    expect(quick?.title).to.equal(expectedLabel);
    expect(resolvedFilenames).to.deep.equal(['notes/resume4.docx']);
  });

  it('picks an installed-app quick-export target before generating the file', async () => {
    const events: string[] = [];
    window.localStorage.setItem(
      'docblocks-export-options',
      JSON.stringify({ ...DEFAULT_OPTIONS, format: 'md' }),
    );

    await act(async () => {
      root.render(
        createElement(
          EditorProvider,
          { initialMarkdown: '# Export me\n' },
          createElement(ExportToolbarControls, {
            selectedFile: '/notes/draft.md',
            showVideoExport: false,
            destinationAdapter: {
              pickBeforeSave: true,
              showDestination: false,
              resolveTarget: async (filename) => ({ grantId: null, displayPath: filename }),
              pickTarget: async (filename) => {
                events.push(`pick:${filename}`);
                return { grantId: 'browser-save', displayPath: filename };
              },
              saveBlob: async (_blob, filename, target) => {
                events.push(`save:${filename}`);
                return target ?? null;
              },
            },
          }),
        ),
      );
    });

    const menu = container.querySelector<HTMLButtonElement>('[aria-label="Export and share"]');
    await act(async () => menu!.click());
    await waitFor(
      () => buttonByText(document.body, 'Save MD as...') !== undefined,
      'the installed-app quick export',
    );
    await act(async () => buttonByText(document.body, 'Save MD as...')!.click());
    await waitFor(() => events.length === 2, 'the quick export to save');

    expect(events).to.deep.equal(['pick:notes/draft.md', 'save:notes/draft.md']);
  });

  it('keeps the export dialog open without an error when native save is cancelled', async () => {
    await act(async () => {
      root.render(
        createElement(
          EditorProvider,
          { initialMarkdown: '# Export me\n' },
          createElement(ExportToolbarControls, {
            selectedFile: '/notes/resume4.md',
            trigger: 'button',
            showVideoExport: false,
            destinationAdapter: {
              resolveTarget: async (filename) => ({
                grantId: 'export-grant',
                displayPath: filename,
              }),
              pickTarget: async () => null,
              saveBlob: async () => null,
            },
          }),
        ),
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Export document"]');
    await act(async () => trigger!.click());
    await waitFor(() => buttonByText(document.body, 'Save PDF') !== undefined, 'the export dialog');
    await act(async () => buttonByText(document.body, 'Markdown')!.click());
    await act(async () => buttonByText(document.body, 'Save MD')!.click());
    await waitFor(
      () => buttonByText(document.body, 'Save MD')?.disabled === false,
      'the cancelled export to settle',
    );

    expect(document.body.querySelector('.db-export-dialog')).not.to.equal(null);
    expect(document.body.querySelector('[role="alert"]')).to.equal(null);
  });

  it('hides Electron IPC internals around an actionable save failure', async () => {
    const actionableFailure =
      'Couldn\'t save "resume4.docx". It may be open in another app. Close the file and try again.';
    const electronFailure = `Error invoking remote method 'exports:save': Error: ${actionableFailure}`;

    await act(async () => {
      root.render(
        createElement(
          EditorProvider,
          { initialMarkdown: '# Export me\n' },
          createElement(ExportToolbarControls, {
            selectedFile: '/notes/resume4.md',
            trigger: 'button',
            showVideoExport: false,
            saveBlob: async () => {
              throw new Error(electronFailure);
            },
          }),
        ),
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Export document"]');
    await act(async () => trigger!.click());
    await waitFor(
      () => buttonByText(document.body, 'Save PDF to Downloads') !== undefined,
      'the export dialog',
    );
    await act(async () => buttonByText(document.body, 'Markdown')!.click());
    await act(async () => buttonByText(document.body, 'Save MD to Downloads')!.click());
    await waitFor(
      () => document.body.textContent?.includes(actionableFailure) === true,
      'the actionable export failure',
    );

    const alertText = document.body.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alertText).to.equal(`Export failed: ${actionableFailure}`);
    expect(alertText).not.to.include('remote method');
    expect(alertText).not.to.include('exports:save');
  });

  it('clears the failure when the dialog is dismissed and reopened', async () => {
    await openDialogAndExport();

    await act(async () => buttonByText(document.body, 'Cancel')!.click());
    expect(document.body.textContent).to.not.include(SAVE_FAILURE);

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Export document"]');
    await act(async () => trigger!.click());
    await waitFor(
      () => buttonByText(document.body, 'Save MD to Downloads') !== undefined,
      'the export dialog',
    );
    expect(document.body.textContent).to.not.include(SAVE_FAILURE);
  });
});

describe('ExportDialog error', () => {
  it('renders the failure without blocking a retry', async () => {
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
            error: 'Export failed: an image could not be read.',
            onExport: (options) => exported.push(options.format),
            onClose: () => undefined,
          }),
        );
      });

      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).to.include('an image could not be read.');

      const exportButton = buttonByText(container, 'Export');
      expect(exportButton?.disabled).to.equal(false);
      await act(async () => exportButton!.click());
      expect(exported).to.deep.equal([DEFAULT_OPTIONS.format]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('renders no alert when there is no error', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(ExportDialog, {
            initial: DEFAULT_OPTIONS,
            exporting: false,
            onExport: () => undefined,
            onClose: () => undefined,
          }),
        );
      });

      expect(container.querySelector('[role="alert"]')).to.equal(null);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
