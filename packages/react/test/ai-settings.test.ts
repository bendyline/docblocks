import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  AiModelDownloadInfo,
  AiModelInfo,
  AiProgress,
  AiPreferences,
  AiResult,
  AiStatus,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';

import { AiSettingsControls } from '../src/Settings/AiSettings.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const OPTED_OUT: AiPreferences = { enabled: false, model: null, reviewMode: 'explicit' };
const OPTED_IN: AiPreferences = { ...OPTED_OUT, enabled: true };

const MODELS: AiModelInfo[] = [
  { id: 'gezel:writer', label: 'Writer', local: false, contextWindow: null, isDefault: true },
  {
    id: 'llama-cpp:qwen3-4b',
    label: 'qwen3-4b · llama-cpp',
    local: true,
    contextWindow: 32_768,
    isDefault: false,
  },
];

const READY: AiStatus = {
  kind: 'ready',
  provider: { name: 'Gezel', version: '1.1.2', mode: 'installed' },
  model: MODELS[0],
  activeRequests: 0,
};

function fakeAi(status: AiStatus, preferences: AiPreferences, providerInstalled = true) {
  const listeners = new Set<(next: AiStatus) => void>();
  const calls: string[] = [];
  let current = preferences;
  let resolveConnect: (result: AiResult<AiStatus>) => void = () => undefined;
  const api: DocBlocksHostAiAPI = {
    providerInstalled: async () => providerInstalled,
    status: async () => status,
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPreferences: async () => current,
    async setPreferences(patch) {
      calls.push(`set ${JSON.stringify(patch)}`);
      current = { ...current, ...patch };
      return current;
    },
    connect() {
      calls.push('connect');
      return new Promise((resolve) => {
        resolveConnect = resolve;
      });
    },
    async disconnect() {
      calls.push('disconnect');
      return { ok: true, value: null };
    },
    models: async () => ({ ok: true, value: MODELS }),
    chat() {
      throw new Error('not used by Settings');
    },
  };
  return {
    api,
    calls,
    emit(next: AiStatus) {
      for (const listener of listeners) listener(next);
    },
    finishConnect(result: AiResult<AiStatus>) {
      resolveConnect(result);
    },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

async function render(api: DocBlocksHostAiAPI) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(AiSettingsControls, { ai: api }));
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

function buttonLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('button')).map((button) => button.textContent ?? '');
}

describe('AiSettingsControls', () => {
  it('explains that the built-in host does not require the Gezel app', async () => {
    const fake = fakeAi({ kind: 'unavailable', reason: 'opt-out' }, OPTED_OUT, false);
    const { container, cleanup } = await render(fake.api);
    try {
      const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
      expect(box?.checked).to.equal(false);
      expect(container.textContent).to.contain('Use AI features');
      expect(container.textContent).to.contain(
        'DocBlocks runs a private Gezel service inside this app',
      );
      expect(container.textContent).not.to.contain('Connecting your Gezel app is optional');
      expect(buttonLabels(container)).to.deep.equal([]);
      expect(container.querySelector('select')).to.equal(null);
    } finally {
      await cleanup();
    }
  });

  it('opting in starts built-in AI without connecting the Gezel app', async () => {
    const fake = fakeAi({ kind: 'unavailable', reason: 'opt-out' }, OPTED_OUT);
    const { container, cleanup } = await render(fake.api);
    try {
      const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
      expect(box?.closest('label')?.nextElementSibling?.textContent).to.contain(
        'Connecting your Gezel app is optional',
      );
      await act(async () => {
        box?.click();
      });
      await flush();
      expect(fake.calls).to.deep.equal(['set {"enabled":true}']);

      await act(async () => {
        fake.emit({
          kind: 'connecting',
          step: 'detecting',
          verificationCode: null,
          progress: null,
        });
      });
      expect(container.textContent).to.contain('Looking for Gezel');
      expect(container.querySelector('.db-settings-ai-code')).to.equal(null);
      expect(
        container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled,
      ).to.equal(false);

      await act(async () => {
        fake.emit({
          ...READY,
          provider: { name: 'Gezel', version: '1.1.2', mode: 'hosted' },
        });
      });
      await flush();
      expect(container.textContent).to.contain('Running Gezel 1.1.2 inside DocBlocks');
    } finally {
      await cleanup();
    }
  });

  it('shows hosted AI controls even when the standalone Gezel app is absent', async () => {
    const hosted: AiStatus = {
      ...READY,
      provider: { name: 'Gezel', version: '1.1.2', mode: 'hosted' },
    };
    const fake = fakeAi(hosted, OPTED_IN, false);
    const { container, cleanup } = await render(fake.api);
    try {
      expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).to.equal(
        true,
      );
      expect(container.textContent).to.contain('Running Gezel 1.1.2 inside DocBlocks');
      expect(buttonLabels(container)).to.deep.equal([]);
      expect(container.querySelector('select')).not.to.equal(null);
    } finally {
      await cleanup();
    }
  });

  it('treats a stopped provider as a built-in restart, not a connection requirement', async () => {
    const fake = fakeAi({ kind: 'unavailable', reason: 'not-running' }, OPTED_IN);
    const { container, cleanup } = await render(fake.api);
    try {
      expect(container.textContent).to.contain('DocBlocks is restarting its built-in AI service');
      expect(buttonLabels(container)).to.deep.equal([]);
    } finally {
      await cleanup();
    }
  });

  it('shows a failed attempt, but not a cancelled one', async () => {
    const hosted: AiStatus = {
      ...READY,
      provider: { name: 'Gezel', version: '1.1.2', mode: 'hosted' },
    };
    const fake = fakeAi(hosted, OPTED_IN);
    const { container, cleanup } = await render(fake.api);
    try {
      const connect = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Connect Gezel app…',
      );
      await act(async () => {
        connect?.click();
      });
      await act(async () => {
        fake.finishConnect({
          ok: false,
          error: { code: 'inference-disabled', message: 'Connected apps are switched off.' },
        });
      });
      await flush();
      expect(container.querySelector('[role="alert"]')?.textContent).to.equal(
        'Connected apps are switched off.',
      );

      await act(async () => {
        container.querySelector('button')?.click();
      });
      await act(async () => {
        fake.finishConnect({ ok: false, error: { code: 'cancelled', message: 'Cancelled.' } });
      });
      await flush();
      expect(container.querySelector('[role="alert"]')).to.equal(null);
    } finally {
      await cleanup();
    }
  });

  it('hides Connect for an error that retrying cannot fix', async () => {
    const fake = fakeAi(
      {
        kind: 'error',
        error: { code: 'runtime-missing', message: 'AI support is not included in this build.' },
        retryable: false,
      },
      OPTED_IN,
    );
    const { container, cleanup } = await render(fake.api);
    try {
      expect(container.textContent).to.contain('AI support is not included in this build.');
      expect(buttonLabels(container)).to.deep.equal([]);
    } finally {
      await cleanup();
    }
  });

  it('says when DocBlocks runs Gezel itself, and shows engine progress first', async () => {
    const fake = fakeAi(
      {
        kind: 'connecting',
        step: 'preparing-model',
        verificationCode: null,
        progress: {
          phase: 'engine',
          message: 'downloading the llama-server engine',
          percent: 42.4,
        },
      },
      OPTED_IN,
    );
    const { container, cleanup } = await render(fake.api);
    try {
      expect(container.querySelector('[role="status"]')?.textContent).to.equal(
        'Getting ready: downloading the llama-server engine (42%)',
      );
      await act(async () => {
        fake.emit({
          ...READY,
          provider: { name: 'Gezel', version: '1.1.2', mode: 'hosted' },
        });
      });
      await flush();
      expect(container.querySelector('[role="status"]')?.textContent).to.equal(
        'Running Gezel 1.1.2 inside DocBlocks, with the models already on this device.',
      );
    } finally {
      await cleanup();
    }
  });

  it('once connected, picks a model and can switch back to built-in AI', async () => {
    const fake = fakeAi(READY, OPTED_IN);
    const { container, cleanup } = await render(fake.api);
    try {
      const select = container.querySelector<HTMLSelectElement>('select');
      expect(Array.from(select?.options ?? []).map((option) => option.textContent)).to.deep.equal([
        "Gezel's default: Writer",
        'Writer',
        'qwen3-4b · llama-cpp (on this device)',
      ]);
      await act(async () => {
        if (!select) return;
        select.value = 'llama-cpp:qwen3-4b';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await flush();
      expect(fake.calls).to.deep.equal(['set {"model":"llama-cpp:qwen3-4b"}']);

      await act(async () => {
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === 'Use built-in AI')
          ?.click();
      });
      await flush();
      expect(fake.calls).to.include('disconnect');
    } finally {
      await cleanup();
    }
  });

  it('downloads a model with progress, selects it, and adds it to the model picker', async () => {
    const downloadable: AiModelDownloadInfo = {
      id: 'llama-cpp:small-writer',
      label: 'Small Writer',
      contextWindow: 32_768,
      downloadBytes: 2 * 1024 ** 3,
      state: 'download-required',
    };
    const installed: AiModelInfo = {
      id: downloadable.id,
      label: downloadable.label,
      local: true,
      contextWindow: downloadable.contextWindow,
      isDefault: false,
    };
    const done = deferred<AiResult<AiModelInfo>>();
    let progressListener: ((progress: AiProgress) => void) | null = null;
    let installedModels: readonly AiModelInfo[] = [];
    const fake = fakeAi({ ...READY, model: null }, OPTED_IN, false);
    fake.api.models = async () => ({ ok: true, value: installedModels });
    fake.api.availableModels = async () => ({ ok: true, value: [downloadable] });
    fake.api.installModel = (_modelId, onProgress) => {
      progressListener = onProgress;
      return { done: done.promise, cancel: () => undefined };
    };

    const { container, cleanup } = await render(fake.api);
    try {
      expect(container.textContent).to.contain('No models installed');
      await act(async () => {
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === 'Add model…')
          ?.click();
      });
      await flush();
      expect(container.textContent).to.contain('Small Writer — 2.0 GB');

      await act(async () => {
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === 'Download model')
          ?.click();
        progressListener?.({
          phase: 'weights',
          message: 'Downloading Small Writer…',
          percent: 42,
        });
      });
      expect(container.querySelector('progress')?.value).to.equal(42);
      expect(container.textContent).to.contain('Downloading Small Writer… (42%)');

      installedModels = [installed];
      await act(async () => done.resolve({ ok: true, value: installed }));
      await flush();
      expect(fake.calls).to.include('set {"model":"llama-cpp:small-writer"}');
      const modelSelect = container.querySelectorAll<HTMLSelectElement>('select')[0];
      expect(Array.from(modelSelect?.options ?? []).map((option) => option.textContent)).to.include(
        'Small Writer (on this device)',
      );
      expect(modelSelect?.value).to.equal('llama-cpp:small-writer');
    } finally {
      await cleanup();
    }
  });
});
