import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  AiImagesAPI,
  AiKnowledgeState,
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

const KNOWLEDGE: AiKnowledgeState = {
  catalogs: [
    {
      id: 'science',
      name: 'Science',
      description: 'Science reference',
      version: '2',
      installedVersion: '1',
      enabled: true,
      updateAvailable: true,
      downloadBytes: 1024,
      documents: 20,
      state: 'installed',
      percent: null,
      message: null,
    },
    {
      id: 'history',
      name: 'History',
      description: 'History reference',
      version: '1',
      installedVersion: null,
      enabled: false,
      updateAvailable: false,
      downloadBytes: 2048,
      documents: 30,
      state: 'available',
      percent: null,
      message: null,
    },
  ],
  improvement: { downloadBytes: 23_856_961, downloading: false },
};
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

function typeInto(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element) as object,
    'value',
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Clicks the button whose text or accessible label is `label`. */
async function clickButton(scope: ParentNode, label: string): Promise<void> {
  await act(async () => {
    const button = Array.from(scope.querySelectorAll('button')).find(
      (candidate) =>
        candidate.textContent === label || candidate.getAttribute('aria-label') === label,
    );
    expect(button, label).not.to.equal(undefined);
    button!.click();
  });
  await flush();
}

function knowledgeApi(
  base: DocBlocksHostAiAPI,
  actions: unknown[],
  state: AiKnowledgeState = KNOWLEDGE,
  update: (action: unknown) => AiResult<null> = () => ({ ok: true, value: null }),
): DocBlocksHostAiAPI {
  return {
    ...base,
    knowledge: {
      state: async () => ({ ok: true, value: state }),
      update: async (action) => {
        actions.push(action);
        return update(action);
      },
    },
  };
}

function imagesApi(): AiImagesAPI {
  return {
    access: async () => ({ kind: 'ready' }),
    onAccess: () => () => undefined,
    requestAccess: async () => ({ ok: true, value: { kind: 'ready' } }),
    models: async () => ({ ok: true, value: [] }),
    installModel() {
      throw new Error('not used by this test');
    },
    removeModel: async () => ({ ok: true, value: null }),
    getPreferences: async () => ({ model: null, designModel: null, aspect: '1:1' }),
    setPreferences: async (patch) => ({ model: null, designModel: null, aspect: '1:1', ...patch }),
    generate() {
      throw new Error('not used by this test');
    },
  };
}

describe('AI knowledge settings', () => {
  it('keeps downloaded catalogs in a bin of collapsed rows, each changed only by a gesture', async () => {
    const actions: unknown[] = [];
    const { container, cleanup } = await render(knowledgeApi(fakeAi(READY, OPTED_IN).api, actions));
    try {
      const bin = container.querySelector<HTMLElement>('.db-knowledge-bin');
      expect(bin?.textContent).to.contain('Downloaded catalogs').and.contain('Science');
      // Only downloaded catalogs are in the bin, and searching belongs to adding.
      expect(bin?.textContent).not.to.contain('History');
      expect(container.querySelector('input[type="search"]')).to.equal(null);

      const toggle = bin!.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
      expect(toggle.getAttribute('aria-expanded')).to.equal('false');
      expect(toggle.textContent).to.contain('In use · Update available');
      expect(bin!.textContent).not.to.contain('Science reference');
      expect(buttonLabels(bin!)).not.to.include('Update to 2');

      await act(async () => toggle.click());
      expect(toggle.getAttribute('aria-expanded')).to.equal('true');
      expect(bin!.textContent)
        .to.contain('Science reference')
        .and.contain('Version 1 · 20 documents · 0.0 MB');
      expect(actions).to.deep.equal([]);

      await clickButton(bin!, 'Update to 2');
      await act(async () =>
        bin!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
      );
      await flush();
      await clickButton(container, 'Improve knowledge results with a 23 MB model download');
      expect(actions).to.deep.equal([
        { action: 'install', catalogId: 'science' },
        { action: 'disable', catalogId: 'science' },
        { action: 'improve' },
      ]);
      await clickButton(bin!, 'Remove Science…');
      expect(actions).to.have.length(3);
      await clickButton(bin!, 'Confirm removal');
      expect(actions.at(-1)).to.deep.equal({ action: 'remove', catalogId: 'science' });

      await act(async () => toggle.click());
      expect(toggle.getAttribute('aria-expanded')).to.equal('false');
      expect(bin!.textContent).not.to.contain('Science reference');
    } finally {
      await cleanup();
    }
  });

  it('says the bin is empty instead of listing catalogs that are not downloaded', async () => {
    const available = { ...KNOWLEDGE, catalogs: KNOWLEDGE.catalogs.slice(1) };
    const { container, cleanup } = await render(
      knowledgeApi(fakeAi(READY, OPTED_IN).api, [], available),
    );
    try {
      const bin = container.querySelector<HTMLElement>('.db-knowledge-bin');
      expect(bin?.textContent).to.contain('No catalogs downloaded yet.');
      expect(bin?.textContent).not.to.contain('History');
      expect(buttonLabels(bin!)).to.include('Add catalog…');
    } finally {
      await cleanup();
    }
  });

  it('adds catalogs from their own dialog, the one place to search them', async () => {
    const actions: unknown[] = [];
    const { container, cleanup } = await render(knowledgeApi(fakeAi(READY, OPTED_IN).api, actions));
    try {
      await clickButton(container, 'Add catalog…');
      const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog?.querySelector('h2')?.textContent).to.equal('Add knowledge catalog');
      // Every catalog the service offers, the downloaded one marked as such.
      expect(dialog?.querySelectorAll('.db-knowledge-catalog')).to.have.length(2);
      expect(dialog?.textContent).to.contain('History reference').and.contain('Downloaded');
      expect(dialog?.querySelector('[aria-label="Download Science"]')).to.equal(null);
      // What can still be added leads, ahead of the provider's own order.
      expect(
        Array.from(
          dialog!.querySelectorAll('.db-knowledge-catalog-name'),
          (name) => name.textContent,
        ),
      ).to.deep.equal(['History', 'Science']);

      const search = dialog!.querySelector<HTMLInputElement>('input[type="search"]')!;
      expect(document.activeElement).to.equal(search);
      await act(async () => typeInto(search, 'HIST'));
      expect(dialog!.querySelectorAll('.db-knowledge-catalog')).to.have.length(1);
      expect(dialog!.querySelector('mark')?.textContent).to.equal('Hist');
      await act(async () => typeInto(search, 'geology'));
      expect(dialog!.querySelector('[role="status"]')?.textContent).to.equal(
        'No catalogs match “geology”.',
      );
      await act(async () => typeInto(search, ''));

      expect(actions).to.deep.equal([]);
      await clickButton(dialog!, 'Download History');
      expect(actions).to.deep.equal([{ action: 'install', catalogId: 'history' }]);
      await clickButton(dialog!, 'Done');
      expect(document.body.querySelector('[role="dialog"]')).to.equal(null);
    } finally {
      await cleanup();
    }
  });

  it('shows a failed download in the add dialog rather than behind it', async () => {
    const failure = 'Gezel could not download History.';
    const { container, cleanup } = await render(
      knowledgeApi(fakeAi(READY, OPTED_IN).api, [], KNOWLEDGE, () => ({
        ok: false,
        error: { code: 'unknown', message: failure },
      })),
    );
    try {
      await clickButton(container, 'Add catalog…');
      const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
      await clickButton(dialog, 'Download History');
      expect(dialog.querySelector('[role="alert"]')?.textContent).to.equal(failure);
      expect(container.querySelector('[role="alert"]')).to.equal(null);
      // Closing the dialog closes the matter; Settings does not inherit it.
      await clickButton(dialog, 'Done');
      expect(container.querySelector('[role="alert"]')).to.equal(null);
    } finally {
      await cleanup();
    }
  });
  it('offers the improvement download only while it would help, never naming the model', async () => {
    const fake = fakeAi(READY, OPTED_IN);
    const textFor = async (improvement: AiKnowledgeState['improvement']) => {
      const { container, cleanup } = await render({
        ...fake.api,
        knowledge: {
          state: async () => ({ ok: true, value: { ...KNOWLEDGE, improvement } }),
          update: async () => ({ ok: true, value: null }),
        },
      });
      try {
        return container.textContent ?? '';
      } finally {
        await cleanup();
      }
    };
    const offered = await textFor({ downloadBytes: 23_856_961, downloading: false });
    expect(offered).to.contain('Improve knowledge results with a 23 MB model download');
    expect(offered.toLowerCase()).not.to.contain('rerank');
    expect(await textFor({ downloadBytes: 8 * 1024 ** 2, downloading: false })).to.contain(
      'with an 8 MB model download',
    );
    expect(await textFor({ downloadBytes: 18 * 1024 ** 2, downloading: false })).to.contain(
      'with an 18 MB model download',
    );
    // Once chosen it downloads quietly, and once installed the offer is gone.
    for (const improvement of [{ downloadBytes: 23_856_961, downloading: true }, null]) {
      const text = await textFor(improvement);
      expect(text).not.to.contain('Improve knowledge results');
      expect(text.toLowerCase()).not.to.contain('rerank');
    }
  });
  it('does not read catalogs while AI is off', async () => {
    const fake = fakeAi({ kind: 'unavailable', reason: 'opt-out' }, OPTED_OUT);
    let calls = 0;
    const { cleanup } = await render({
      ...fake.api,
      knowledge: {
        state: async () => {
          calls++;
          return { ok: true, value: KNOWLEDGE };
        },
        update: async () => ({ ok: true, value: null }),
      },
    });
    try {
      expect(calls).to.equal(0);
    } finally {
      await cleanup();
    }
  });
  it('shows provider errors without claiming an empty installed library', async () => {
    const fake = fakeAi(READY, OPTED_IN);
    const { container, cleanup } = await render({
      ...fake.api,
      knowledge: {
        state: async () => ({
          ok: false,
          error: { code: 'unknown', message: 'Gezel could not list catalogs.' },
        }),
        update: async () => ({ ok: true, value: null }),
      },
    });
    try {
      expect(container.querySelector('[role="alert"]')?.textContent).to.equal(
        'Gezel could not list catalogs.',
      );
      expect(container.textContent).not.to.contain('No catalogs downloaded');
      expect(container.querySelector('.db-knowledge-bin')).to.equal(null);
      expect(buttonLabels(container)).to.include('Try again');
    } finally {
      await cleanup();
    }
  });

  it('explains a provider without catalogs instead of offering them', async () => {
    const fake = fakeAi(READY, OPTED_IN);
    const reason =
      'Knowledge catalogs aren’t available with the AI built into DocBlocks yet. They work when DocBlocks is connected to the Gezel app.';
    const { container, cleanup } = await render({
      ...fake.api,
      knowledge: {
        state: async () => ({ ok: false, error: { code: 'unsupported', message: reason } }),
        update: async () => ({ ok: true, value: null }),
      },
    });
    try {
      const section = container.querySelector('[aria-label="Knowledge catalogs"]');
      expect(section?.textContent).to.contain(reason);
      // Not an error, and no promise that passages reach requests.
      expect(section?.querySelector('[role="alert"]')).to.equal(null);
      expect(section?.textContent).not.to.contain('are included in each request');
      expect(section?.querySelector('button')).to.equal(null);
    } finally {
      await cleanup();
    }
  });

  it('shows the knowledge and image sections once each as the provider changes', async () => {
    const fake = fakeAi(READY, OPTED_IN);
    const { container, cleanup } = await render({
      ...knowledgeApi(fake.api, []),
      images: imagesApi(),
    });
    const sections = (heading: string) =>
      Array.from(container.querySelectorAll('h3')).filter((h3) => h3.textContent === heading);
    try {
      for (const mode of ['installed', 'hosted', 'hosted', 'installed'] as const) {
        await act(async () => {
          fake.emit({ ...READY, provider: { ...READY.provider, mode } });
        });
        await flush();
        expect(sections('Knowledge catalogs'), mode).to.have.length(1);
        expect(sections('Image generation'), mode).to.have.length(1);
      }
    } finally {
      await cleanup();
    }
  });
});

describe('AiSettingsControls', () => {
  it('explains that the built-in host does not require the Gezel app', async () => {
    const fake = fakeAi({ kind: 'unavailable', reason: 'opt-out' }, OPTED_OUT, false);
    const { container, cleanup } = await render(fake.api);
    try {
      const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
      expect(box?.checked).to.equal(false);
      expect(container.textContent).to.contain('Use AI features');
      expect(container.textContent).to.contain('run entirely on this device — no account needed');
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
      const hint = box?.closest('label')?.nextElementSibling?.textContent;
      expect(hint).to.contain('run entirely on this device — no account needed');
      expect(hint).not.to.contain('Connecting your Gezel app');
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
      expect(container.textContent).to.contain(
        'Looking to see if shared AI services (Gezel) are installed',
      );
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
      expect(container.querySelector('[role="status"]')?.textContent).to.equal('');
      expect(container.querySelector('select')).not.to.equal(null);
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
      expect(container.textContent).not.to.contain('inside DocBlocks, with the models');
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

  it('asks for an on-device model when hosted AI has none', async () => {
    const fake = fakeAi(
      { ...READY, provider: { name: 'Gezel', version: '1.1.2', mode: 'hosted' }, model: null },
      OPTED_IN,
    );
    const { container, cleanup } = await render(fake.api);
    try {
      expect(container.querySelector('[role="status"]')?.textContent).to.equal(
        'Add an on-device model to start using AI.',
      );
    } finally {
      await cleanup();
    }
  });

  it('shows engine progress, then no status sentence once hosted AI has a model', async () => {
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
      expect(container.querySelector('[role="status"]')?.textContent).to.equal('');
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
        'Default: Writer',
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

  it('describes a missing selection without showing its internal model ID or changing it', async () => {
    const missing = 'llama-cpp:6d818d84-3d15-46eb-9a63-e9b64d6edb3b';
    const fake = fakeAi(READY, { ...OPTED_IN, model: missing });
    const { container, cleanup } = await render(fake.api);
    try {
      const select = container.querySelector<HTMLSelectElement>('select');
      expect(select?.value).to.equal(missing);
      expect(select?.selectedOptions[0]?.textContent).to.equal(
        'Previously selected model (not available)',
      );
      expect(select?.selectedOptions[0]?.disabled).to.equal(true);
      expect(container.textContent).not.to.include(missing);
      expect(fake.calls).to.deep.equal([]);
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
      fit: null,
      score: null,
      recommended: false,
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

  it('offers the recommended download first and rates the rest for this device', async () => {
    const base = { contextWindow: 32_768, state: 'download-required' as const };
    const recommended: AiModelDownloadInfo = {
      ...base,
      id: 'llama-cpp:qwen',
      label: 'Qwen',
      downloadBytes: 15 * 1024 ** 3,
      fit: { tier: 'fits', label: 'fits in VRAM', detail: 'Runs fully on the GPU.' },
      score: 100,
      recommended: true,
    };
    const slow: AiModelDownloadInfo = {
      ...base,
      id: 'llama-cpp:qwen-q8',
      label: 'Qwen Q8',
      downloadBytes: 27 * 1024 ** 3,
      fit: { tier: 'tight', label: 'may run slowly', detail: 'Pages from system RAM.' },
      score: 40,
      recommended: false,
    };
    const fake = fakeAi({ ...READY, model: null }, OPTED_IN, false);
    fake.api.models = async () => ({ ok: true, value: [] });
    fake.api.availableModels = async () => ({ ok: true, value: [recommended, slow] });
    fake.api.installModel = () => ({ done: new Promise(() => undefined), cancel: () => undefined });

    const { container, cleanup } = await render(fake.api);
    try {
      await act(async () => {
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === 'Add model…')
          ?.click();
      });
      await flush();
      const select = container.querySelectorAll<HTMLSelectElement>('select')[1];
      expect(Array.from(select?.options ?? []).map((option) => option.textContent)).to.deep.equal([
        'Qwen — 15 GB · Recommended',
        'Qwen Q8 — 27 GB · 40% match · may run slowly',
      ]);
      expect(select?.value).to.equal('llama-cpp:qwen');
      expect(container.textContent).to.contain(
        'Recommended for this device · 15 GB · fits in VRAM',
      );

      await act(async () => {
        select!.value = 'llama-cpp:qwen-q8';
        select!.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const hint = Array.from(container.querySelectorAll('p')).find((p) =>
        p.textContent?.startsWith('Downloads and runs on this device'),
      );
      expect(hint?.textContent).to.equal(
        'Downloads and runs on this device · 27 GB · may run slowly',
      );
      expect(hint?.title).to.equal('Pages from system RAM.');
    } finally {
      await cleanup();
    }
  });

  it('shows system model names and readiness reasons without allowing an unavailable choice', async () => {
    const apple: AiModelInfo = {
      id: 'system:apple',
      label: 'Apple Foundation Models',
      local: true,
      contextWindow: 4096,
      isDefault: false,
      availability: 'unavailable',
      unavailableReason: 'This device does not support Apple Intelligence.',
    };
    const nano: AiModelInfo = {
      ...apple,
      id: 'system:nano',
      label: 'Gemini Nano (Android ML Kit)',
      availability: 'download-required',
      unavailableReason: 'Choose Add model… to prepare this model.',
    };
    const fake = fakeAi(READY, { ...OPTED_IN, model: apple.id }, false);
    fake.api.models = async () => ({ ok: true, value: [...MODELS, apple, nano] });
    const { container, cleanup } = await render(fake.api);
    try {
      const select = container.querySelector<HTMLSelectElement>('select')!;
      expect(select.value).to.equal(apple.id);
      expect(
        select.querySelector<HTMLOptionElement>('option[value="system:apple"]')?.disabled,
      ).to.equal(true);
      expect(
        select.querySelector<HTMLOptionElement>('option[value="system:nano"]')?.disabled,
      ).to.equal(true);
      expect(container.textContent).to.contain(
        'Apple Foundation Models: This device does not support Apple Intelligence.',
      );
      expect(container.textContent).to.contain('Gemini Nano (Android ML Kit) (download required)');
      expect(fake.calls).to.deep.equal([]);
      await act(async () => {
        select.value = MODELS[0].id;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await flush();
      expect(fake.calls).to.deep.equal(['set {"model":"gezel:writer"}']);
    } finally {
      await cleanup();
    }
  });

  it('lists a ready system model even with no downloaded weights', async () => {
    const system: AiModelInfo = {
      id: 'system:apple',
      label: 'Apple Foundation Models',
      local: true,
      contextWindow: 4096,
      isDefault: true,
      availability: 'available',
    };
    const fake = fakeAi(
      { ...READY, model: system, provider: { ...READY.provider, mode: 'hosted' } },
      OPTED_IN,
      false,
    );
    fake.api.models = async () => ({ ok: true, value: [system] });
    const { container, cleanup } = await render(fake.api);
    try {
      const select = container.querySelector<HTMLSelectElement>('select')!;
      expect(select.disabled).to.equal(false);
      expect(select.options[1].disabled).to.equal(false);
      expect(select.options[1].textContent).to.equal('Apple Foundation Models (on this device)');
      expect(buttonLabels(container)).to.deep.equal([]);
    } finally {
      await cleanup();
    }
  });
});
