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
  AiImageStyle,
  AiImageRequest,
  AiImageResult,
  AiProgress,
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
  licenseUrl: 'https://huggingface.co/example/model/blob/main/LICENSE',
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

async function renderImageSettings(images: AiImagesAPI) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(AiImageSettings, { images })));
  await waitFor(() => Boolean(container.textContent?.includes('Add model…')), 'image settings');
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe('AiImageSettings', () => {
  for (const kind of ['model', 'style'] as const) {
    it(`keeps an image ${kind} download across Settings mounts and allows explicit cancellation`, async () => {
      let installed = false;
      let starts = 0;
      let cancellations = 0;
      let progress: (value: AiProgress) => void = () => undefined;
      let finish!: (value: AiResult<AiImageModel & AiImageStyle>) => void;
      const item: AiImageModel & AiImageStyle = {
        ...FLUX,
        id: 'background-image',
        label: 'Background image',
        baseModels: [FLUX.id],
      };
      const fixture = fakeImages();
      fixture.images.models = async () => ({
        ok: true,
        value: [
          FLUX,
          ...(kind === 'model'
            ? [
                {
                  ...item,
                  state: installed ? ('installed' as const) : ('download-required' as const),
                },
              ]
            : []),
        ],
      });
      fixture.images.styles = async () => ({
        ok: true,
        value:
          kind === 'style'
            ? [{ ...item, state: installed ? 'installed' : 'download-required' }]
            : [],
      });
      fixture.images.removeStyle = async () => ({ ok: true, value: null });
      const install = (_id: string, listener?: (value: AiProgress) => void) => {
        starts++;
        progress = listener ?? (() => undefined);
        return {
          done: new Promise<AiResult<AiImageModel & AiImageStyle>>((resolve) => {
            finish = resolve;
          }),
          cancel: () => {
            cancellations++;
            finish({ ok: false, error: { code: 'cancelled', message: 'Stopped' } });
          },
        };
      };
      fixture.images.installModel = install;
      fixture.images.installStyle = install;
      let view: Awaited<ReturnType<typeof renderImageSettings>> | null = await renderImageSettings(
        fixture.images,
      );
      const start = async () => {
        await act(async () =>
          Array.from(view!.container.querySelectorAll('button'))
            .find((b) => b.textContent === `Add ${kind}…`)!
            .click(),
        );
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
        await act(async () =>
          dialog
            .querySelector<HTMLButtonElement>('button[aria-label="Download Background image"]')!
            .click(),
        );
      };
      try {
        await start();
        await view.cleanup();
        view = null;
        progress({ phase: 'downloading', message: 'Downloading', percent: 64 });
        expect(cancellations).to.equal(0);
        view = await renderImageSettings(fixture.images);
        expect(view.container.querySelector('progress')?.value).to.equal(64);
        expect(starts).to.equal(1);
        await act(async () =>
          Array.from(view!.container.querySelectorAll('button'))
            .find((b) => b.textContent === 'Cancel')!
            .click(),
        );
        expect(cancellations).to.equal(1);
        expect(view.container.querySelector('progress')).to.equal(null);
        expect(view.container.querySelector('[role="alert"]')).to.equal(null);
        await start();
        await view.cleanup();
        view = null;
        installed = true;
        await act(async () => finish({ ok: true, value: item }));
        view = await renderImageSettings(fixture.images);
        expect(view.container.querySelector('progress')).to.equal(null);
        expect(
          view.container.querySelector('button[aria-label="Remove Background image"]'),
        ).not.to.equal(null);
        expect(starts).to.equal(2);
        expect(cancellations).to.equal(1);
      } finally {
        await view?.cleanup();
      }
    });
  }

  it('shows installed models, links licenses, and hides models that do not fit from the catalog', async () => {
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

    const smaller = {
      ...FLUX,
      id: 'smaller',
      label: 'Small model',
      state: 'download-required' as const,
    };
    const limited = {
      ...MING,
      id: 'limited',
      label: 'Over limit',
      fit: { verdict: 'over-limit' as const, reason: 'Raise the limit' },
    };
    const { images } = fakeImages({ models: [FLUX, MING, smaller, limited] });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(AiImageSettings, { images })));
    await waitFor(() => container.querySelectorAll('li').length === 1, 'the model rows');
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.some((b) => b.textContent === 'Remove')).to.equal(true);
    expect(buttons.some((b) => b.textContent === 'Download')).to.equal(false);
    expect(container.querySelector('a')?.href).to.equal(FLUX.licenseUrl);
    await act(async () => buttons.find((b) => b.textContent === 'Add model…')!.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).to.include('Small model');
    expect(dialog.textContent).not.to.include(MING.label);
    expect(dialog.textContent).not.to.include('Over limit');
    await setField(
      dialog.querySelector<HTMLInputElement>('input[type="search"]')!,
      'nothing matches',
    );
    expect(dialog.querySelectorAll('li').length).to.equal(0);
    await act(async () =>
      Array.from(dialog.querySelectorAll('button'))
        .find((b) => b.textContent === 'Done')!
        .click(),
    );
    const selects = Array.from(container.querySelectorAll('select'));
    expect(selects.map((select) => select.options.length)).to.deep.equal([2, 2]);
    await act(async () => root.unmount());
    container.remove();
  });
});

describe('image rendering styles', () => {
  const watercolor: AiImageStyle = {
    id: 'watercolor',
    label: 'Watercolor',
    description: 'A soft watercolor.',
    state: 'installed',
    downloadBytes: 100,
    license: 'MIT',
    licenseUrl: 'https://huggingface.co/example/style/blob/main/LICENSE',
    commercialUse: true,
    baseModels: [FLUX.id],
  };

  it('offers only installed compatible styles and sends the selection to the renderer', async () => {
    const second = { ...FLUX, id: 'sd-cpp:second', label: 'Second model' };
    const fixture = fakeImages({ models: [FLUX, second] });
    fixture.images.styles = async () => ({
      ok: true,
      value: [
        watercolor,
        { ...watercolor, id: 'wrong', label: 'Wrong base', baseModels: ['other'] },
        { ...watercolor, id: 'missing', label: 'Not downloaded', state: 'download-required' },
      ],
    });
    const panel = await renderPanel(fixture.images);
    await waitFor(
      () => Boolean(panel.container.textContent?.includes('Rendering style')),
      'style selector',
    );
    const selects = Array.from(panel.container.querySelectorAll('select'));
    const style = selects.find((select) =>
      select.parentElement?.textContent?.includes('Rendering style'),
    )!;
    expect(Array.from(style.options).map((option) => option.text)).to.deep.equal([
      'No style',
      'Watercolor',
    ]);
    await act(async () => {
      style.value = 'watercolor';
      style.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await setField(panel.container.querySelector('textarea')!, 'A lighthouse');
    await act(async () => panel.button('Generate').click());
    expect(fixture.requests[0]?.style).to.equal('watercolor');
    await act(async () =>
      fixture.renders[0]!.finish({ ok: false, error: { code: 'cancelled', message: 'Stopped' } }),
    );
    const model = selects.find((select) => select !== style)!;
    await act(async () => {
      model.value = second.id;
      model.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => panel.button('Generate').click());
    expect(fixture.requests[1]?.style).to.equal(undefined);
    await panel.cleanup();
  });

  it('uses a separate compatible-style catalog and keeps download progress after closing it', async () => {
    const fixture = fakeImages();
    let finish!: (value: AiResult<AiImageStyle>) => void;
    let downloaded = false;
    fixture.images.styles = async () => ({
      ok: true,
      value: [
        { ...watercolor, state: downloaded ? 'installed' : 'download-required' },
        {
          ...watercolor,
          id: 'wrong',
          label: 'Wrong base',
          baseModels: ['other'],
          state: 'download-required',
        },
      ],
    });
    fixture.images.installStyle = (_id, onProgress) => {
      onProgress?.({ phase: 'downloading', message: 'Downloading style…', percent: 25 });
      return {
        done: new Promise((resolve) => {
          finish = resolve;
        }),
        cancel: () => undefined,
      };
    };
    fixture.images.removeStyle = async () => ({ ok: true, value: null });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(createElement(AiImageSettings, { images: fixture.images })),
      );
      await waitFor(
        () => Boolean(container.textContent?.includes('Add style…')),
        'style catalog button',
      );
      expect(container.textContent).not.to.include('Watercolor');
      await act(async () =>
        Array.from(container.querySelectorAll('button'))
          .find((b) => b.textContent === 'Add style…')!
          .click(),
      );
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(dialog.textContent).to.include('Watercolor');
      expect(dialog.textContent).not.to.include('Wrong base');
      expect(dialog.querySelector('a')?.href).to.equal(watercolor.licenseUrl);
      await act(async () =>
        dialog
          .querySelector<HTMLButtonElement>('button[aria-label="Download Watercolor"]')!
          .click(),
      );
      await act(async () =>
        Array.from(dialog.querySelectorAll('button'))
          .find((b) => b.textContent === 'Done')!
          .click(),
      );
      expect(container.querySelector('progress')?.value).to.equal(25);
      downloaded = true;
      await act(async () => finish({ ok: true, value: watercolor }));
      expect(container.querySelector('button[aria-label="Remove Watercolor"]')).not.to.equal(null);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
