/**
 * The phone's "Add recommended model" path, end to end: Gezel's bundled
 * mobile catalog and its docbench ranking (through the real embedding
 * runtime), DocBlocks' mobile AI host, and the shared Settings panel.
 *
 * Which model wins is Gezel's call and moves with its catalog, so this pins
 * the contract instead: a phone gets exactly one measured recommendation and
 * Settings offers it as a single action. A catalog that loses its docbench
 * data (as Gezel's did before gezel-capacitor 1.1.3) fails here rather than
 * silently falling back to the full picker.
 */

import assert from 'node:assert/strict';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { connectEmbeddingRuntime, type GezelRuntimePlugin } from '@bendyline/gezel-capacitor';
import type { MobileProvider } from '@bendyline/gezel/mobile-providers';
import type { AiModelDownloadInfo, DocBlocksHostAiAPI } from '@bendyline/docblocks/host';
import { createMobileAi } from '../src/ai/host';
import { AiSettingsControls } from '../../react/src/Settings/AiSettings';

// The root Mocha/tsx loader does not inherit the React package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const GB = 1024 ** 3;

const capabilities = {
  text: true,
  tools: false,
  images: false,
  structuredOutput: false,
  foregroundOnly: true,
};

const llama: MobileProvider = {
  id: 'llama-cpp',
  name: 'Local',
  locality: 'on-device',
  availability: 'available',
  contextTokens: 4096,
  maxOutputTokens: 2048,
  capabilities,
};

const apple: MobileProvider = {
  ...llama,
  id: 'apple-foundation-models',
  name: 'System AI',
  maxOutputTokens: 1024,
};

/** A phone with nothing downloaded: its per-app memory budget and its RAM. */
function phone(memory: { budget: number; physical: number }, providers: MobileProvider[]) {
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected native mutation');
  };
  const runtime: GezelRuntimePlugin = {
    providers: async () => ({ providers }),
    listModels: async () => ({
      models: [],
      memoryBudgetBytes: memory.budget,
      physicalMemoryBytes: memory.physical,
    }),
    generate: unexpected,
    cancel: async () => {},
    addListener: async () => ({ remove: async () => {} }),
    releaseModel: async () => {},
    prepareProvider: unexpected,
    cancelProviderPreparation: unexpected,
    importModel: unexpected,
    selectModel: unexpected,
    removeModel: unexpected,
    resolveModelSource: unexpected,
    cancelModelSourceResolution: unexpected,
    listModelDownloads: async () => ({ downloads: [] }),
    startModelDownload: unexpected,
    resumeModelDownload: unexpected,
    cancelModelDownload: unexpected,
    removeModelDownload: unexpected,
  };
  let preferences: unknown = { enabled: true, model: null, reviewMode: 'explicit' };
  return createMobileAi({
    load: async () => connectEmbeddingRuntime(runtime, { pollIntervalMs: 10 }),
    readPreferences: () => preferences,
    writePreferences: (value) => {
      preferences = value;
    },
    requestTimeoutMs: 1000,
  }).ai;
}

async function recommendation(ai: DocBlocksHostAiAPI): Promise<AiModelDownloadInfo> {
  assert.equal((await ai.status()).kind, 'ready');
  const available = await ai.availableModels!();
  assert.ok(available.ok, JSON.stringify(available));
  const recommended = available.value.filter((model) => model.recommended);
  assert.equal(recommended.length, 1, 'exactly one recommended download');
  assert.ok(recommended[0]!.docbench, 'the recommendation is measured on docbench');
  return recommended[0]!;
}

/** Render Settings and return the button labels once the recommendation shows. */
async function settingsButtons(ai: DocBlocksHostAiAPI): Promise<string[]> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const labels = () =>
    Array.from(container.querySelectorAll('button')).map((button) => button.textContent ?? '');
  try {
    await act(async () => root.render(createElement(AiSettingsControls, { ai })));
    for (let attempt = 0; attempt < 100; attempt++) {
      if (labels().some((label) => label.startsWith('Add recommended model ('))) break;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    return labels();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

describe('recommended model on a phone (bundled Gezel catalog)', () => {
  const phones = [
    { name: '4 GB', budget: 2 * GB, physical: 4 * GB },
    { name: '6 GB', budget: 3 * GB, physical: 6 * GB },
    { name: '8 GB', budget: 5 * GB, physical: 8 * GB },
    { name: '12 GB', budget: 8 * GB, physical: 12 * GB },
  ];

  for (const memory of phones) {
    it(`offers one measured model as a single action on a ${memory.name} phone`, async () => {
      const ai = phone(memory, [llama]);
      const recommended = await recommendation(ai);
      const buttons = await settingsButtons(ai);
      const action = buttons.find((label) => label.startsWith('Add recommended model ('));
      assert.ok(action, `Settings offered: ${JSON.stringify(buttons)}`);
      assert.ok(action.startsWith(`Add recommended model (${recommended.label}, `), action);
      assert.ok(action.endsWith(`, docbench ${Math.round(recommended.docbench!.score)})`), action);
      assert.ok(buttons.includes('Pick a model…'));
    });
  }

  it('still steers to the download when Apple Foundation Models is ready', async () => {
    const ai = phone(phones[2]!, [llama, apple]);
    const models = await ai.models();
    assert.ok(models.ok);
    const ready = models.value.filter((model) => model.availability === 'available');
    assert.deepEqual(
      ready.map((model) => [model.id, model.system]),
      [['apple-foundation-models:apple-foundation-models', true]],
    );
    const recommended = await recommendation(ai);
    const buttons = await settingsButtons(ai);
    assert.ok(
      buttons.some((label) => label.startsWith(`Add recommended model (${recommended.label}, `)),
      JSON.stringify(buttons),
    );
  });
});
