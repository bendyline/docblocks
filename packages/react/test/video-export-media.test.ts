import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorProvider } from '@bendyline/squisq-editor-react';
import type { MediaProvider } from '@bendyline/squisq/schemas';
import type { ContentContainer, ContentEntry } from '@bendyline/squisq/storage';
import { setFrontmatterValues } from '@bendyline/squisq/markdown';
import {
  defaultPresentationHints,
  serializePresentationHints,
  PRESENTATION_HINTS_KEY,
} from '@bendyline/squisq/transform';
import { ExportToolbarControls } from '../src/Export/ExportToolbarControls.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text,
  );
}

const SIDECAR_PATH = 'audio/take.webm.timing.json';
const NARRATION_VIDEO =
  '<video src="audio/take.webm" data-squisq-video-placement="picture-in-picture" ' +
  'data-squisq-video-lock-to-block="false"></video>';

/** A workspace holding only the take's timing sidecar, narrating `sourceText`. */
function sidecarWorkspace(sourceText: string, reads: string[] = []): ContentContainer {
  const sidecar = new TextEncoder().encode(
    JSON.stringify({
      version: 3,
      sourceText,
      duration: 12,
      bookmarks: [],
      blocks: [
        {
          blockId: 'narrated-export',
          blockIndex: 0,
          charStart: 0,
          charEnd: sourceText.length,
          startSec: 0,
          endSec: 12,
        },
      ],
    }),
  );
  return {
    async readFile(path) {
      reads.push(path);
      return path === SIDECAR_PATH ? sidecar.buffer.slice(0) : null;
    },
    async writeFile() {},
    async removeFile() {},
    async listFiles(): Promise<ContentEntry[]> {
      return [];
    },
    async exists(path) {
      return path === SIDECAR_PATH;
    },
    async getDocumentPath() {
      return null;
    },
    async readDocument() {
      return null;
    },
    async writeDocument() {},
  };
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

  it('resolves narration timing before opening the video export modal', async () => {
    const reads: string[] = [];
    const workspaceContainer = sidecarWorkspace('Narrated export', reads);
    const markdown = `${NARRATION_VIDEO}\n\n# Narrated export`;

    await act(async () => {
      root.render(
        createElement(
          EditorProvider,
          { initialMarkdown: markdown },
          createElement(ExportToolbarControls, {
            selectedFile: '/draft.md',
            workspaceContainer,
          }),
        ),
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Export and share"]')?.click();
    });
    await act(async () => buttonByText(container, 'Export video...')?.click());
    await waitFor(() => reads.includes(SIDECAR_PATH), 'the narration timing sidecar to be read');
    await waitFor(
      () => document.body.querySelector('[data-squisq-video-export-modal]') !== null,
      'the video export modal',
    );

    expect(reads).to.include(SIDECAR_PATH);
    expect(document.body.textContent).not.to.include('Video export could not be loaded.');
  });

  it('says why a dynamic deck cannot be exported once the narration is stale', async () => {
    const workspaceContainer = sidecarWorkspace('A take recorded for different words');
    const markdown = setFrontmatterValues(`${NARRATION_VIDEO}\n\n# Narrated export`, {
      'squisq-transform': 'dynamic-slides',
      [PRESENTATION_HINTS_KEY]: serializePresentationHints(defaultPresentationHints()),
    });

    await act(async () => {
      root.render(
        createElement(
          EditorProvider,
          { initialMarkdown: markdown },
          createElement(ExportToolbarControls, {
            selectedFile: '/draft.md',
            workspaceContainer,
          }),
        ),
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Export and share"]')?.click();
    });
    await act(async () => buttonByText(container, 'Export video...')?.click());
    await waitFor(
      () => document.body.querySelector('[role="alert"]') !== null,
      'the video export error',
    );

    const alert = document.body.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).to.include('Video export is unavailable.');
    expect(alert).to.include('The narration no longer matches the document.');
    expect(document.body.querySelector('[data-squisq-video-export-modal]')).to.equal(null);
  });
});
