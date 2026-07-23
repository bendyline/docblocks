import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorProvider } from '@bendyline/squisq-editor-react';
import type { MediaProvider } from '@bendyline/squisq/schemas';
import { ExportToolbarControls } from '../src/Export/ExportToolbarControls.js';

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

describe('Video export media', () => {
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

  it('forwards the active document media provider to the export pipeline', async () => {
    const providerFailure = 'The document media provider was reached.';
    let listMediaCalls = 0;
    const mediaProvider: MediaProvider = {
      async resolveUrl(path) {
        return path;
      },
      async listMedia() {
        listMediaCalls += 1;
        throw new Error(providerFailure);
      },
      async addMedia() {
        throw new Error('Not used by export.');
      },
      async removeMedia() {
        throw new Error('Not used by export.');
      },
      dispose() {},
    };

    await act(async () => {
      root.render(
        createElement(
          EditorProvider,
          { initialMarkdown: '# Export media' },
          createElement(ExportToolbarControls, {
            selectedFile: '/draft.md',
            mediaProvider,
          }),
        ),
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Export and share"]')?.click();
    });
    await act(async () => buttonByText(container, 'Export video...')?.click());
    await waitFor(
      () => document.body.querySelector('[data-squisq-video-export-modal]') !== null,
      'the video export modal',
    );

    await act(async () => buttonByText(document.body, 'Export Video')?.click());
    await waitFor(() => listMediaCalls === 1, 'the media provider to be used');
    await waitFor(
      () => document.body.textContent?.includes(providerFailure) === true,
      'the provider failure to be surfaced',
    );

    expect(listMediaCalls).to.equal(1);
    expect(document.body.textContent).to.include(providerFailure);
  });
});
