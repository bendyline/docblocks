import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  AiModelInfo,
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

function fakeAi(status: AiStatus, preferences: AiPreferences) {
  const listeners = new Set<(next: AiStatus) => void>();
  const calls: string[] = [];
  let current = preferences;
  let resolveConnect: (result: AiResult<AiStatus>) => void = () => undefined;
  const api: DocBlocksHostAiAPI = {
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
  it('offers only the opt-in while AI is off', async () => {
    const fake = fakeAi({ kind: 'unavailable', reason: 'opt-out' }, OPTED_OUT);
    const { container, cleanup } = await render(fake.api);
    try {
      const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
      expect(box?.checked).to.equal(false);
      expect(container.textContent).to.contain('Use Gezel for AI features');
      expect(buttonLabels(container)).to.deep.equal([]);
      expect(container.querySelector('select')).to.equal(null);
    } finally {
      await cleanup();
    }
  });

  it('opting in connects at once and shows the code to type in Gezel', async () => {
    const fake = fakeAi({ kind: 'unavailable', reason: 'opt-out' }, OPTED_OUT);
    const { container, cleanup } = await render(fake.api);
    try {
      const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
      await act(async () => {
        box?.click();
      });
      await flush();
      expect(fake.calls).to.deep.equal(['set {"enabled":true}', 'connect']);

      await act(async () => {
        fake.emit({
          kind: 'connecting',
          step: 'awaiting-approval',
          verificationCode: 'K7Q2XD',
          progress: null,
        });
      });
      expect(container.textContent).to.contain('Waiting for approval in Gezel');
      expect(container.querySelector('.db-settings-ai-code')?.textContent).to.equal('K7Q2XD');
      // Approval can take minutes; switching AI off must stay possible.
      expect(
        container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled,
      ).to.equal(false);

      await act(async () => {
        fake.emit(READY);
        fake.finishConnect({ ok: true, value: READY });
      });
      await flush();
      expect(container.textContent).to.contain('Connected to Gezel 1.1.2.');
      expect(container.querySelector('.db-settings-ai-code')).to.equal(null);
    } finally {
      await cleanup();
    }
  });

  it('explains a stopped provider and offers to connect', async () => {
    const fake = fakeAi({ kind: 'unavailable', reason: 'not-running' }, OPTED_IN);
    const { container, cleanup } = await render(fake.api);
    try {
      expect(container.textContent).to.contain('Gezel is not running.');
      expect(buttonLabels(container)).to.deep.equal(['Connect']);
    } finally {
      await cleanup();
    }
  });

  it('shows a failed attempt, but not a cancelled one', async () => {
    const fake = fakeAi({ kind: 'unavailable', reason: 'disconnected' }, OPTED_IN);
    const { container, cleanup } = await render(fake.api);
    try {
      const connect = container.querySelector('button');
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

  it('once connected, picks a model and can disconnect', async () => {
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
          .find((button) => button.textContent === 'Disconnect')
          ?.click();
      });
      await flush();
      expect(fake.calls).to.include('disconnect');
    } finally {
      await cleanup();
    }
  });
});
