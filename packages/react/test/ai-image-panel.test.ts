import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  EditorProvider,
  useEditorContext,
  type EditorContextValue,
} from '@bendyline/squisq-editor-react';
import type {
  AiImageAccess,
  AiImageEvent,
  AiImageModel,
  AiImageRequest,
  AiImageResult,
  AiImagesAPI,
  AiResult,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';

import { AiImagePanel } from '../src/Ai/AiImagePanel.js';
import { imageProgressText } from '../src/Ai/ai-image-access.js';
import {
  generatedImageName,
  imageAltText,
  imageMarkdown,
  imageSlug,
} from '../src/Ai/insert-generated-image.js';
import { AiImageSettings } from '../src/Settings/AiImageSettings.js';
import { imageModelFacts } from '../src/Settings/image-model-facts.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const SOURCE = '# Notes\n\nA lighthouse stands on the cliff.\n';
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 4, 0, 0, 0, 4,
  0,
]);

const FLUX: AiImageModel = {
  id: 'sd-cpp:flux-2-klein-4b-q4',
  label: 'FLUX.2 Klein 4B (Q4)',
  description: null,
  state: 'installed',
  downloadBytes: 5_207_178_964,
  shared: false,
  license: 'Apache 2.0',
  commercialUse: true,
  rendersText: true,
  promptStyle: 'sentences',
  hardwareTier: 'high',
  minRamGb: 16,
  fit: { verdict: 'fits', reason: '' },
};

const MING: AiImageModel = {
  ...FLUX,
  id: 'sd-cpp:ming-image-0.1-design-bf16',
  label: 'Ming Image 0.1 Design (BF16)',
  state: 'download-required',
  downloadBytes: 49_243_658_314,
  license: 'MIT',
  hardwareTier: 'workstation',
  minRamGb: 96,
  fit: { verdict: 'wont-run', reason: 'This computer has too little memory for this model.' },
};

function unused(): never {
  throw new Error('Not used by this test');
}

function fakeImages(options: { access?: AiImageAccess; models?: AiImageModel[] } = {}) {
  let access: AiImageAccess = options.access ?? { kind: 'ready' };
  const accessListeners = new Set<(access: AiImageAccess) => void>();
  const requests: AiImageRequest[] = [];
  const renders: Array<{
    emit: (event: AiImageEvent) => void;
    finish: (result: AiResult<AiImageResult>) => void;
    cancelled: boolean;
  }> = [];
  const images: AiImagesAPI = {
    access: async () => access,
    onAccess(listener) {
      accessListeners.add(listener);
      return () => accessListeners.delete(listener);
    },
    async requestAccess() {
      access = { kind: 'ready' };
      for (const listener of accessListeners) listener(access);
      return { ok: true, value: access };
    },
    models: async () => ({ ok: true, value: options.models ?? [FLUX] }),
    installModel: unused,
    removeModel: unused,
    getPreferences: async () => ({ model: null, designModel: null, aspect: '1:1' }),
    setPreferences: async (patch) => ({ model: null, designModel: null, aspect: '1:1', ...patch }),
    generate(request, onEvent) {
      requests.push(request);
      let finish!: (result: AiResult<AiImageResult>) => void;
      const done = new Promise<AiResult<AiImageResult>>((resolve) => {
        finish = resolve;
      });
      const render = { emit: onEvent, finish, cancelled: false };
      renders.push(render);
      return {
        done,
        cancel: () => {
          render.cancelled = true;
          finish({ ok: false, error: { code: 'cancelled', message: 'Stopped' } });
        },
      };
    },
  };
  return { images, requests, renders };
}

function aiWith(images: AiImagesAPI): DocBlocksHostAiAPI {
  return {
    images,
    providerInstalled: unused,
    status: unused,
    onStatus: unused,
    getPreferences: unused,
    setPreferences: unused,
    connect: unused,
    disconnect: unused,
    models: unused,
    chat: unused,
  };
}

async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${label}: ${document.body.textContent ?? ''}`);
}

async function setField(field: HTMLTextAreaElement | HTMLInputElement, value: string) {
  await act(async () => {
    const prototype =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function renderPanel(images: AiImagesAPI) {
  const saved: Array<{ name: string; mimeType: string; bytes: number }> = [];
  const inserted: string[] = [];
  let editor: EditorContextValue | null = null;
  const mediaProvider = {
    resolveUrl: async (path: string) => path,
    listMedia: async () => [],
    async addMedia(name: string, data: ArrayBuffer | Blob | Uint8Array, mimeType: string) {
      saved.push({ name, mimeType, bytes: data instanceof Blob ? data.size : data.byteLength });
      return `notes_files/${name}`;
    },
    removeMedia: async () => undefined,
    dispose: () => undefined,
  };
  function Probe() {
    editor = useEditorContext();
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(EditorProvider, {
        initialMarkdown: SOURCE,
        mediaProvider: mediaProvider as never,
        children: [
          createElement(Probe, { key: 'probe' }),
          createElement(AiImagePanel, {
            key: 'panel',
            ai: aiWith(images),
            onClose: () => undefined,
          }),
        ],
      }),
    );
  });
  const original = editor!.insertBlockAfterCursor;
  void original;
  // Record what the panel inserts; the editor's own insertion is squisq's to test.
  (
    editor as unknown as { insertBlockAfterCursor: (block: string) => boolean }
  ).insertBlockAfterCursor = (block: string) => {
    inserted.push(block);
    return true;
  };
  const button = (label: string) => {
    const found = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!found) throw new Error(`No "${label}" button in: ${container.textContent ?? ''}`);
    return found;
  };
  return {
    container,
    saved,
    inserted,
    button,
    async click(label: string) {
      const target = button(label);
      await act(async () => target.click());
    },
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe('generated image insertion helpers', () => {
  it('names files by prompt, seed and time so a regenerated image never overwrites', () => {
    expect(imageSlug('A Watercolor Lighthouse, at dusk!')).to.equal(
      'a-watercolor-lighthouse-at-dusk',
    );
    expect(imageSlug('???')).to.equal('image');
    expect(generatedImageName('A lighthouse', 7, 1_000)).to.equal(
      'generated-a-lighthouse-7-rs.png',
    );
    expect(generatedImageName('A lighthouse', 7, 2_000)).to.not.equal(
      generatedImageName('A lighthouse', 7, 1_000),
    );
  });

  it('writes an escaped image block with one-line alt text', () => {
    expect(imageMarkdown('My Notes_files/generated-a-7.png', 'A [bright]\nlighthouse')).to.equal(
      '![A \\[bright\\] lighthouse](<My Notes_files/generated-a-7.png>)',
    );
    expect(imageAltText('word '.repeat(80)).length).to.be.at.most(160);
  });

  it('describes each render phase', () => {
    expect(imageProgressText(null, 'Flux')).to.equal('Starting…');
    expect(
      imageProgressText(
        { phase: 'loading-model', step: 0, totalSteps: 0, secondsPerStep: null },
        'Flux',
      ),
    ).to.match(/^Loading Flux… The first image/);
    expect(
      imageProgressText({ phase: 'sampling', step: 2, totalSteps: 12, secondsPerStep: 2 }, 'Flux'),
    ).to.equal('Step 2 of 12 · about 20 s left');
    expect(
      imageProgressText(
        { phase: 'decoding', step: 3, totalSteps: 49, secondsPerStep: null },
        'Flux',
      ),
    ).to.equal('Finishing the image…');
  });
});

describe('AiImagePanel', () => {
  it('generates from a description, shows progress, and inserts the saved image', async () => {
    const { images, requests, renders } = fakeImages();
    const panel = await renderPanel(images);
    await waitFor(() => panel.container.querySelector('textarea') !== null, 'the form');
    await setField(panel.container.querySelector('textarea')!, 'A lighthouse at dusk');
    await panel.click('Wide');
    await panel.click('Generate');
    expect(requests).to.deep.equal([
      { prompt: 'A lighthouse at dusk', aspect: '16:9', model: FLUX.id },
    ]);
    await act(async () =>
      renders[0]!.emit({
        kind: 'progress',
        progress: { phase: 'sampling', step: 1, totalSteps: 4, secondsPerStep: 2 },
      }),
    );
    expect(panel.container.textContent).to.include('Step 1 of 4 · about 6 s left');
    expect(panel.button('Stop').disabled).to.equal(false);
    await act(async () => {
      renders[0]!.finish({
        ok: true,
        value: {
          mimeType: 'image/png',
          data: PNG.buffer.slice(0),
          width: 1344,
          height: 768,
          seed: 7,
          model: FLUX.id,
          durationMs: 12_000,
        },
      });
    });
    await waitFor(() => panel.container.querySelector('img') !== null, 'the preview');
    await panel.click('Insert');
    await waitFor(() => panel.inserted.length === 1, 'the insertion');
    expect(panel.saved).to.have.length(1);
    expect(panel.saved[0]).to.include({ mimeType: 'image/png', bytes: PNG.byteLength });
    expect(panel.saved[0]!.name).to.match(/^generated-a-lighthouse-at-dusk-7-[a-z0-9]+\.png$/u);
    expect(panel.inserted[0]).to.equal(
      `![A lighthouse at dusk](notes_files/${panel.saved[0]!.name})`,
    );
    expect(panel.button('Inserted').disabled).to.equal(true);
    await panel.cleanup();
  });

  it('stops a render and asks Gezel to allow image generation when needed', async () => {
    const { images, renders } = fakeImages();
    const panel = await renderPanel(images);
    await waitFor(() => panel.container.querySelector('textarea') !== null, 'the form');
    await setField(panel.container.querySelector('textarea')!, 'A chart');
    await panel.click('Generate');
    await panel.click('Stop');
    expect(renders[0]!.cancelled).to.equal(true);
    await waitFor(() => panel.container.textContent?.includes('Stopped.') === true, 'the stop');
    await panel.cleanup();

    const gated = fakeImages({ access: { kind: 'needs-approval' } });
    const second = await renderPanel(gated.images);
    await waitFor(
      () => second.container.textContent?.includes('Allow image generation') === true,
      'the allow button',
    );
    await second.click('Allow image generation…');
    await waitFor(
      () => second.container.querySelector('textarea') !== null,
      'the form after allowing',
    );
    await second.cleanup();
  });

  it('says so when no image model is installed', async () => {
    const { images } = fakeImages({ models: [MING] });
    const panel = await renderPanel(images);
    await waitFor(
      () => panel.container.textContent?.includes('No image model is installed yet') === true,
      'the empty state',
    );
    expect(panel.container.querySelector('textarea')).to.equal(null);
    await panel.cleanup();
  });
});

describe('AiImageSettings', () => {
  it('states size, license and hardware, and refuses a model that cannot run here', async () => {
    expect(imageModelFacts(MING)).to.deep.equal([
      '45.9 GB',
      'MIT',
      'Draws legible text',
      'Workstation · 96 GB+ memory',
      'This computer has too little memory for this model.',
    ]);
    expect(imageModelFacts({ ...FLUX, commercialUse: false, shared: true })).to.include.members([
      'Not for commercial use',
      'Shared with Gezel, no download needed',
    ]);

    const { images } = fakeImages({ models: [FLUX, MING] });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(AiImageSettings, { images })));
    await waitFor(() => container.querySelectorAll('li').length === 2, 'the model rows');
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.some((b) => b.textContent === 'Remove')).to.equal(true);
    expect(buttons.find((b) => b.textContent === 'Download')?.disabled).to.equal(true);
    const selects = Array.from(container.querySelectorAll('select'));
    expect(selects.map((select) => select.options.length)).to.deep.equal([2, 2]);
    await act(async () => root.unmount());
    container.remove();
  });
});
