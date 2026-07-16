import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorProvider } from '@bendyline/squisq-editor-react';
import { ExportDialog } from '../src/Export/ExportDialog.js';
import { ExportToolbarControls } from '../src/Export/ExportToolbarControls.js';
import { DEFAULT_OPTIONS } from '../src/Export/export-options.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text,
  );
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe('Animated GIF export availability', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function renderToolbar(ffmpegCoreUrl?: string): Promise<void> {
    await act(async () => {
      root.render(
        createElement(
          EditorProvider,
          { initialMarkdown: '# Export me' },
          createElement(ExportToolbarControls, {
            selectedFile: '/draft.md',
            ...(ffmpegCoreUrl
              ? { ffmpegWasm: { coreURL: ffmpegCoreUrl, wasmURL: '/ffmpeg-core/core.wasm' } }
              : {}),
          }),
        ),
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Export and share"]')?.click();
    });
  }

  it('only advertises GIF export when the host supplies ffmpeg.wasm', async () => {
    await renderToolbar();
    expect(buttonByText(container, 'Export Animated GIF...')).to.equal(undefined);

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);

    await renderToolbar('/ffmpeg-core/ffmpeg-core.js');
    expect(buttonByText(container, 'Export Animated GIF...')).not.to.equal(undefined);
  });

  it('surfaces the richer GIF flow from the built-in export dialog', async () => {
    let opened = 0;
    await act(async () => {
      root.render(
        createElement(ExportDialog, {
          initial: DEFAULT_OPTIONS,
          exporting: false,
          onExport: () => undefined,
          onAnimatedGifExport: () => {
            opened += 1;
          },
          onClose: () => undefined,
        }),
      );
    });

    const animatedGif = buttonByText(container, 'Animated GIF...');
    expect(animatedGif).not.to.equal(undefined);
    await act(async () => animatedGif?.click());
    expect(opened).to.equal(1);
  });

  it('opens the video modal with Animated GIF preselected', async () => {
    await renderToolbar('/ffmpeg-core/ffmpeg-core.js');
    await act(async () => buttonByText(container, 'Export Animated GIF...')?.click());
    await waitFor(
      () => document.body.querySelector('select[aria-label="Format"]') !== null,
      'the Animated GIF format selector',
    );

    const format = document.body.querySelector<HTMLSelectElement>('select[aria-label="Format"]');
    expect(format).not.to.equal(null);
    expect(format?.value).to.equal('gif');
  });
});
