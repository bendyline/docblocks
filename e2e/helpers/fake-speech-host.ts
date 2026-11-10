import type { BrowserContext, Page } from '@playwright/test';

/**
 * Give the browser site a speech engine like the mobile apps', so Settings
 * shows its Dictation and Narration sections and their model rows.
 *
 * The host carries only `env` and `speech`. Capabilities are derived from the
 * members a host actually has, so documents stay in browser storage and
 * nothing else changes. A download reports `progressPercent` and then waits
 * until it is cancelled, which keeps the in-progress row on screen.
 *
 * The script is a string, not a function: run under tsx (the affordance
 * crawl), named inner functions gain a helper call the page does not have.
 */
function fakeSpeechHostScript(progressPercent: number): string {
  return `(() => {
  const MB = 1024 * 1024;
  const percent = ${JSON.stringify(progressPercent)};
  const models = [
    { id: 'whisper-tiny.en', kind: 'stt', label: 'Whisper Tiny (English)',
      description: 'Fastest. Good for short notes.', downloadBytes: 74 * MB,
      recommended: false, license: 'MIT',
      licenseUrl: 'https://github.com/openai/whisper/blob/main/LICENSE' },
    { id: 'whisper-base.en', kind: 'stt', label: 'Whisper Base (English)',
      description: 'Recommended. More accurate; a little slower.', downloadBytes: 141 * MB,
      recommended: true, license: 'MIT',
      licenseUrl: 'https://github.com/openai/whisper/blob/main/LICENSE' },
    { id: 'kokoro-82m-v1.0', kind: 'tts', label: 'Kokoro (English voices)',
      description: 'Natural US and UK English narration voices.', downloadBytes: 92 * MB,
      recommended: true, license: 'Apache-2.0',
      licenseUrl: 'https://huggingface.co/hexgrad/Kokoro-82M/blob/main/LICENSE' },
  ].map((model) => Object.assign({}, model, { installed: false, source: null }));
  const status = {
    stt: { state: 'download-required', reason: 'Download a dictation model to start dictating.' },
    tts: { state: 'download-required', reason: 'Download the narration voices to read documents aloud.' },
  };
  let preferences = { sttModel: null, voice: null, speed: 1 };
  globalThis.docBlocksHost = {
    env: { surface: 'capacitor', surfaceLabel: 'DocBlocks', platform: 'android',
      appVersion: '0.0.0-e2e', isDev: true },
    speech: {
      status: async () => status,
      onStatus: () => () => undefined,
      catalog: async () => ({ ok: true, value: { models, voices: [] } }),
      installModel: (modelId, onProgress) => {
        const model = models.find((candidate) => candidate.id === modelId);
        const total = model ? model.downloadBytes : MB;
        let settle = () => undefined;
        const done = new Promise((resolve) => { settle = resolve; });
        setTimeout(() => {
          if (onProgress) {
            onProgress({ phase: 'downloading', totalBytes: total,
              receivedBytes: Math.round((total * percent) / 100) });
          }
        }, 50);
        return {
          done,
          cancel: () => settle({ ok: false,
            error: { code: 'cancelled', message: 'Download cancelled.' } }),
        };
      },
      removeModel: async () => ({ ok: true, value: null }),
      getPreferences: async () => preferences,
      setPreferences: async (patch) => {
        preferences = Object.assign({}, preferences, patch);
        return preferences;
      },
      prepare: async () => ({ ok: true, value: null }),
      transcribe: async () => ({ ok: true,
        value: { text: '', language: null, segments: [], durationMs: 0 } }),
      synthesize: () => ({
        done: Promise.resolve({ ok: false,
          error: { code: 'model-missing', message: 'Download the narration voices.' } }),
        cancel: () => undefined,
      }),
    },
  };
})();`;
}

export async function installFakeSpeechHost(
  target: Page | BrowserContext,
  options: { progressPercent?: number } = {},
): Promise<void> {
  await target.addInitScript({ content: fakeSpeechHostScript(options.progressPercent ?? 83) });
}

/**
 * Approximate Android's larger system text: the WebView scales every font
 * size and leaves padding and widths alone. Elements rendered later (a new
 * Settings section) need another call; each element is scaled only once.
 */
export async function scaleText(page: Page, factor: number): Promise<void> {
  await page.evaluate(`(() => {
    const scale = ${JSON.stringify(factor)};
    const elements = [...document.querySelectorAll('body *')].filter(
      (element) => !element.hasAttribute('data-e2e-text-scaled'),
    );
    const sizes = elements.map((element) => parseFloat(getComputedStyle(element).fontSize));
    elements.forEach((element, index) => {
      element.style.fontSize = sizes[index] * scale + 'px';
      element.setAttribute('data-e2e-text-scaled', '');
    });
  })()`);
}
