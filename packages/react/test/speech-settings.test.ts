import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  DocBlocksHostSpeechAPI,
  SpeechCatalog,
  SpeechModelInfo,
  SpeechPreferences,
  SpeechProgress,
  SpeechResult,
  SpeechStatus,
} from '@bendyline/docblocks/host';

import { SpeechSettingsControls } from '../src/Settings/SpeechSettings.js';
import { formatModelSize } from '../src/Speech/format.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const BASE: SpeechModelInfo = {
  id: 'whisper-base.en',
  kind: 'stt',
  label: 'Whisper Base (English)',
  description: 'Recommended.',
  downloadBytes: 147_964_211,
  installed: false,
  source: null,
  recommended: true,
  license: 'MIT',
  licenseUrl: 'https://example.test/mit',
};
const KOKORO: SpeechModelInfo = {
  ...BASE,
  id: 'kokoro-82m-v1.0',
  kind: 'tts',
  label: 'Kokoro (English voices)',
  downloadBytes: 96_538_975,
  license: 'Apache-2.0',
};

function fakeSpeech(
  options: { installed?: boolean; tts?: boolean; updateRequired?: boolean } = {},
) {
  const calls: string[] = [];
  let installed = options.installed ?? false;
  let preferences: SpeechPreferences = { sttModel: null, voice: null, speed: 1 };
  let finishInstall: (result: SpeechResult<SpeechModelInfo>) => void = () => undefined;
  let reportProgress: (progress: SpeechProgress) => void = () => undefined;
  const status = (): SpeechStatus => ({
    stt: installed
      ? { state: 'ready', model: BASE.id }
      : { state: 'download-required', reason: 'Download a dictation model to start dictating.' },
    tts: installed
      ? { state: 'ready' }
      : { state: 'download-required', reason: 'Download voices.' },
  });
  const catalog = (): SpeechCatalog => ({
    models: [
      {
        ...BASE,
        installed,
        source: installed ? 'app' : null,
        ...(!installed && options.updateRequired ? { updateRequired: true } : {}),
      },
      ...(options.tts === false
        ? []
        : [{ ...KOKORO, installed, source: installed ? ('app' as const) : null }]),
    ],
    voices: [
      { id: 'af_heart', label: 'Heart', language: 'en-US', gender: 'female', modelId: KOKORO.id },
      { id: 'bf_emma', label: 'Emma', language: 'en-GB', gender: 'female', modelId: KOKORO.id },
    ],
  });
  const api: DocBlocksHostSpeechAPI = {
    status: async () => status(),
    onStatus: () => () => undefined,
    catalog: async () => ({ ok: true, value: catalog() }),
    getPreferences: async () => preferences,
    async setPreferences(patch) {
      calls.push(`set ${JSON.stringify(patch)}`);
      preferences = { ...preferences, ...patch };
      return preferences;
    },
    prepare: async () => ({ ok: true, value: null }),
    installModel(id, onProgress) {
      calls.push(`install ${id}`);
      reportProgress = (progress) => onProgress?.(progress);
      return {
        done: new Promise((resolve) => {
          finishInstall = resolve;
        }),
        cancel: () => calls.push(`cancel ${id}`),
      };
    },
    async removeModel(id) {
      calls.push(`remove ${id}`);
      installed = false;
      return { ok: true, value: null };
    },
    transcribe: async () => ({
      ok: true,
      value: { text: '', language: null, segments: [], durationMs: 0 },
    }),
    ...(options.tts === false
      ? {}
      : {
          synthesize: () => ({
            done: Promise.resolve({
              ok: true as const,
              value: {
                voice: 'af_heart',
                model: KOKORO.id,
                sampleRate: 24_000,
                durationSec: 0,
                chunks: 0,
              },
            }),
            cancel: () => undefined,
          }),
        }),
  };
  return {
    api,
    calls,
    progress: (p: SpeechProgress) => reportProgress(p),
    complete: () => {
      installed = true;
      finishInstall({ ok: true, value: { ...BASE, installed: true, source: 'app' } });
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(api: DocBlocksHostSpeechAPI) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SpeechSettingsControls, { speech: api }));
  });
  await flush();
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const button = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label);

describe('Speech settings', () => {
  it('formats model sizes', () => {
    expect(formatModelSize(147_964_211)).to.equal('141 MB');
    expect(formatModelSize(2 * 1024 ** 3)).to.equal('2.0 GB');
  });

  it('downloads a model only from a button press and shows progress', async () => {
    const fake = fakeSpeech();
    const view = await render(fake.api);
    try {
      expect(fake.calls).to.deep.equal([]);
      expect(view.container.textContent).to.contain('Download a dictation model');
      await act(async () => button(view.container, 'Download')?.click());
      expect(fake.calls).to.deep.equal(['install whisper-base.en']);
      await act(async () =>
        fake.progress({ phase: 'downloading', receivedBytes: 50, totalBytes: 100 }),
      );
      expect(view.container.querySelector('progress')?.getAttribute('value')).to.equal('50');
      await act(async () => button(view.container, 'Cancel')?.click());
      expect(fake.calls).to.include('cancel whisper-base.en');
      await act(async () => fake.complete());
      await flush();
      expect(view.container.textContent).to.contain('Ready. Use the microphone button');
    } finally {
      await view.cleanup();
    }
  });

  it('offers an update for an older revision and waits for an explicit gesture', async () => {
    const fake = fakeSpeech({ updateRequired: true, tts: false });
    const view = await render(fake.api);
    try {
      expect(fake.calls).to.deep.equal([]);
      expect(view.container.textContent).to.contain('Update required');
      expect(button(view.container, 'Download')).to.equal(undefined);
      expect(button(view.container, 'Remove')).not.to.equal(undefined);
      await act(async () => button(view.container, 'Update')?.click());
      expect(fake.calls).to.deep.equal(['install whisper-base.en']);
      await act(async () => fake.complete());
      await flush();
      expect(button(view.container, 'Update')).to.equal(undefined);
      expect(view.container.textContent).to.contain('Ready. Use the microphone button');
    } finally {
      await view.cleanup();
    }
  });

  it('offers voices, speed and removal once installed', async () => {
    const fake = fakeSpeech({ installed: true });
    const view = await render(fake.api);
    try {
      const voice = Array.from(view.container.querySelectorAll('select')).find((s) =>
        Array.from(s.options).some((o) => o.value === 'bf_emma'),
      );
      expect(voice).to.not.equal(undefined);
      await act(async () => {
        voice!.value = 'bf_emma';
        voice!.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(fake.calls).to.include('set {"voice":"bf_emma"}');
      expect(button(view.container, 'Preview voice')).to.not.equal(undefined);
      expect(view.container.textContent).to.contain('Speech models are using');
      await act(async () => button(view.container, 'Remove')?.click());
      expect(fake.calls).to.include('remove whisper-base.en');
    } finally {
      await view.cleanup();
    }
  });

  it('hides narration when the host has no synthesis engine', async () => {
    const view = await render(fakeSpeech({ tts: false }).api);
    try {
      expect(view.container.textContent).to.contain('Dictation');
      expect(view.container.textContent).to.not.contain('Narration');
    } finally {
      await view.cleanup();
    }
  });
});
