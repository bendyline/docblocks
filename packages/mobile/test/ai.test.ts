import assert from 'node:assert/strict';
import { connectRuntime, type GezelRuntimePlugin } from '@bendyline/gezel-capacitor';
import type { MobileModelInventory, MobileProvider } from '@bendyline/gezel/mobile-providers';
import type { AiChatEvent, AiPreferences } from '@bendyline/docblocks/host';
import { createMobileAi } from '../src/ai/host';
import { catalog } from '../src/ai/models';
const request = {
  purpose: 'write' as const,
  messages: [{ role: 'user' as const, content: 'Hello' }],
  temperature: 0.7,
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function fixture(initial: Partial<AiPreferences> = {}) {
  const calls: string[] = [];
  let emit: (value: { requestId: string; delta: string }) => void = () => {};
  let preferences: unknown = { enabled: false, model: null, reviewMode: 'explicit', ...initial };
  const models: MobileModelInventory = {
    models: [{ id: 'fixture', name: 'Fixture', sizeBytes: 4 }],
  };
  const providers: MobileProvider[] = [
    {
      id: 'llama-cpp',
      name: 'Local',
      locality: 'on-device',
      availability: 'available',
      contextTokens: 4096,
      maxOutputTokens: 2048,
      capabilities: {
        text: true,
        tools: false,
        images: false,
        structuredOutput: false,
        foregroundOnly: true,
      },
    },
  ];
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected native mutation');
  };
  const runtime: GezelRuntimePlugin = {
    providers: async () => {
      calls.push('providers');
      return { providers };
    },
    listModels: async () => {
      calls.push('models');
      return models;
    },
    generate: async (input) => {
      calls.push('generate');
      emit({ requestId: 'stale', delta: 'wrong' });
      emit({ requestId: input.requestId, delta: 'Hello' });
      return { text: 'Hello!', stopReason: 'length' };
    },
    cancel: async () => {
      calls.push('cancel');
    },
    addListener: async (_event, listener) => {
      emit = listener as typeof emit;
      return {
        remove: async () => {
          calls.push('removeListener');
        },
      };
    },
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
  let load = async () => {
    calls.push('load');
    return { runtime, client: connectRuntime(runtime) };
  };
  const host = createMobileAi({
    load: () => load(),
    readPreferences: () => preferences,
    writePreferences: (value) => {
      preferences = value;
    },
    requestTimeoutMs: 40,
    pollMs: 1,
  });
  return {
    ...host,
    runtime,
    models,
    providers,
    calls,
    emit: (id: string, delta: string) => emit({ requestId: id, delta }),
    setLoad: (value: typeof load) => {
      load = value;
    },
  };
}
describe('mobile AI through the Gezel App SDK', () => {
  it('uses native output capacity for writing without a caller cap', async () => {
    const f = fixture();
    let routed: Parameters<GezelRuntimePlugin['generate']>[0] | undefined;
    f.runtime.generate = async (input) => {
      routed = input;
      return { text: 'Complete draft.', stopReason: 'stop' };
    };
    await f.ai.setPreferences({ enabled: true });
    const result = await f.ai.chat(request, () => {}).done;
    assert.ok(result.ok);
    assert.equal(routed?.maxTokens, 2048);
  });

  for (const [providerId, label] of [
    ['apple-foundation-models', 'Apple Foundation Models'],
    ['android-mlkit', 'Gemini Nano (Android ML Kit)'],
  ] as const) {
    it(`lists and explicitly routes ${providerId} alongside downloaded models`, async () => {
      const f = fixture();
      f.providers.push({
        ...f.providers[0],
        id: providerId,
        name: 'System AI',
        maxOutputTokens: 1024,
      });
      const modelId = `${providerId}:${providerId}`;
      let routed: Parameters<GezelRuntimePlugin['generate']>[0] | undefined;
      f.runtime.generate = async (input) => {
        routed = input;
        return { text: 'System reply', stopReason: 'stop' };
      };
      await f.ai.setPreferences({ enabled: true, model: modelId });
      const models = await f.ai.models();
      assert.ok(models.ok);
      if (models.ok) {
        assert.equal(models.value.length, 2);
        assert.equal(models.value.find((m) => m.id === modelId)?.label, label);
        assert.equal(models.value.find((m) => m.id === modelId)?.isDefault, true);
      }
      const result = await f.ai.chat({ ...request, maxTokens: 2048 }, () => {}).done;
      assert.ok(result.ok);
      assert.equal(routed?.providerId, providerId);
      assert.equal(routed?.modelId, providerId);
      assert.equal(routed?.maxTokens, 1024);
    });
  }

  for (const reason of [
    'This device does not support Apple Intelligence.',
    'Enable Apple Intelligence in Settings to use Apple on-device AI.',
    "Apple's on-device model is not ready. The system manages its download and preparation.",
  ]) {
    it(`keeps the system model visible without fallback: ${reason}`, async () => {
      const modelId = 'apple-foundation-models:apple-foundation-models';
      const f = fixture({ enabled: true, model: modelId });
      f.providers.push({
        ...f.providers[0],
        id: 'apple-foundation-models',
        availability: 'unavailable',
        reason,
      });
      const models = await f.ai.models();
      assert.ok(models.ok);
      if (models.ok) {
        const apple = models.value.find((m) => m.id === modelId);
        assert.equal(apple?.availability, 'unavailable');
        assert.equal(apple?.unavailableReason, reason);
        assert.ok(!models.value.some((m) => m.isDefault));
      }
      const result = await f.ai.chat(request, () => {}).done;
      assert.ok(!result.ok);
      if (!result.ok)
        assert.deepEqual(result.error, { code: 'model-unavailable', message: reason });
      assert.ok(!f.calls.includes('generate'));
      const available = await f.ai.availableModels!();
      assert.ok(available.ok);
      if (available.ok) assert.ok(!available.value.some((m) => m.id.includes('apple-foundation')));
    });
  }

  it('prepares ML Kit only by explicit request and makes it selectable afterward', async () => {
    const f = fixture({ enabled: true });
    const system: MobileProvider = {
      ...f.providers[0],
      id: 'android-mlkit',
      availability: 'download-required',
    };
    f.providers.push(system);
    let prepared = false;
    f.runtime.prepareProvider = async (input) => {
      assert.equal(input.providerId, 'android-mlkit');
      prepared = true;
      system.availability = 'available';
    };
    const models = await f.ai.models();
    assert.ok(models.ok);
    if (models.ok) assert.equal(models.value[1].availability, 'download-required');
    const available = await f.ai.availableModels!();
    assert.ok(available.ok);
    if (available.ok) assert.equal(available.value[0].label, 'Gemini Nano (Android ML Kit)');
    assert.equal(prepared, false);
    const result = await f.ai.installModel!('provider:android-mlkit').done;
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.value.id, 'android-mlkit:android-mlkit');
      assert.equal(result.value.availability, 'available');
    }
    assert.equal(prepared, true);
  });

  it('starts nothing when opted out, including status, model queries and rejected requests', async () => {
    const f = fixture();
    f.resume();
    assert.deepEqual(await f.ai.status(), { kind: 'unavailable', reason: 'opt-out' });
    assert.equal(await f.ai.providerInstalled(), false);
    assert.equal((await f.ai.models()).ok, false);
    assert.equal((await f.ai.availableModels!()).ok, false);
    assert.equal((await f.ai.installModel!(catalog[0].id).done).ok, false);
    assert.equal((await f.ai.chat(request, () => {}).done).ok, false);
    assert.deepEqual(f.calls, []);
  });
  it('streams the real SDK transport, reconciles suffixes, caps context and keeps capabilities honest', async () => {
    const f = fixture();
    const events: AiChatEvent[] = [];
    await f.ai.setPreferences({ enabled: true });
    const result = await f.ai.chat(request, (e) => events.push(e)).done;
    assert.equal(result.ok, true);
    if (result.ok)
      assert.deepEqual(result.value, {
        text: 'Hello!',
        model: 'llama-cpp:fixture',
        finishReason: 'length',
        usage: null,
      });
    assert.equal(events.filter((e) => e.kind !== 'delta').length, 1);
    assert.equal(
      events
        .filter((e) => e.kind === 'delta')
        .map((e) => e.text)
        .join(''),
      'Hello!',
    );
    assert.equal(f.ai.transcribe, undefined);
    assert.equal(f.ai.search, undefined);
    assert.equal(f.ai.generateImage, undefined);
  });
  it('never silently substitutes a missing selected model', async () => {
    const f = fixture({ enabled: true, model: 'llama-cpp:gone' });
    const result = await f.ai.chat(request, () => {}).done;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'model-unavailable');
    assert.ok(!f.calls.includes('generate'));
  });
  it('does not download during enable or catalog listing; filters models by native memory budget', async () => {
    const f = fixture();
    f.models.models = [];
    f.providers[0].availability = 'unavailable';
    f.models.memoryBudgetBytes = catalog[0].approxSizeBytes + 512 * 1024 ** 2;
    await f.ai.setPreferences({ enabled: true });
    const result = await f.ai.availableModels!();
    assert.ok(result.ok);
    if (result.ok)
      assert.deepEqual(
        result.value.map((m) => m.id),
        [catalog[0].id],
      );
    assert.equal((await f.ai.installModel!('https://untrusted/model.gguf').done).ok, false);
  });
  it('rejects malformed native inventory without reporting ready', async () => {
    const f = fixture({ enabled: true });
    f.runtime.listModels = async () => ({ ...f.models, injected: true });
    assert.equal((await f.ai.status()).kind, 'error');
    assert.ok(!f.calls.includes('generate'));
  });
  for (const action of ['cancel', 'disable', 'background', 'timeout'] as const) {
    it(`settles exactly once and cancels native work on ${action}`, async () => {
      const f = fixture({ enabled: true });
      const events: AiChatEvent[] = [];
      let resolve!: (value: { text: string; stopReason: 'cancelled' }) => void;
      let started = false;
      f.runtime.generate = (input) => {
        started = true;
        f.emit(input.requestId, 'Partial');
        return new Promise((r) => {
          resolve = r;
        });
      };
      f.runtime.cancel = async () => {
        f.calls.push('cancel');
        resolve({ text: 'Partial', stopReason: 'cancelled' });
      };
      const handle = f.ai.chat(request, (event) => events.push(event));
      while (!started || !events.length) await tick();
      if (action === 'cancel') handle.cancel();
      if (action === 'disable') await f.ai.setPreferences({ enabled: false });
      if (action === 'background') f.suspend();
      const result = await handle.done;
      assert.equal(events.filter((e) => e.kind !== 'delta').length, 1);
      assert.ok(f.calls.includes('cancel'));
      if (action === 'timeout') {
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, 'timeout');
      } else {
        assert.ok(result.ok);
        if (result.ok) {
          assert.equal(result.value.finishReason, 'cancelled');
          assert.equal(result.value.text, 'Partial');
        }
      }
      if (action === 'disable')
        assert.deepEqual(await f.ai.status(), { kind: 'unavailable', reason: 'opt-out' });
    });
  }
  it('cannot resurrect a connection after AI is switched off during loading', async () => {
    const f = fixture();
    let release!: () => void;
    f.setLoad(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return { runtime: f.runtime, client: connectRuntime(f.runtime) };
    });
    const enabling = f.ai.setPreferences({ enabled: true });
    while (!release) await tick();
    await f.ai.setPreferences({ enabled: false });
    release();
    await enabling;
    assert.deepEqual(await f.ai.status(), { kind: 'unavailable', reason: 'opt-out' });
    assert.deepEqual(f.calls, []);
  });
  it('persists AI preferences before changing the runtime', async () => {
    let loaded = false;
    const f = createMobileAi({
      load: async () => {
        loaded = true;
        throw new Error('must not run');
      },
      readPreferences: () => null,
      writePreferences: () => {
        throw new Error('Storage full');
      },
    });
    await assert.rejects(f.ai.setPreferences({ enabled: true }), /Storage full/);
    assert.equal(loaded, false);
    assert.equal((await f.ai.getPreferences()).enabled, false);
  });
});

describe('explicit mobile model installation', () => {
  it('resolves a pinned catalog source, downloads with progress, and returns the installed model', async () => {
    const f = fixture({ enabled: true });
    const entry = catalog[0];
    const source = { ...entry.source, sizeBytes: entry.approxSizeBytes };
    const id = '11111111-1111-4111-8111-111111111111';
    const modelId = '22222222-2222-4222-8222-222222222222';
    const initial = {
      id,
      source,
      name: entry.name,
      downloadedBytes: 0,
      state: 'downloading' as const,
    };
    let started = false;
    f.runtime.resolveModelSource = async (input) => {
      assert.deepEqual(input.source, entry.source);
      return { source };
    };
    f.runtime.startModelDownload = async (input) => {
      assert.deepEqual(input, { source, name: entry.name });
      started = true;
      return { download: initial };
    };
    f.runtime.listModelDownloads = async () => {
      if (!started) return { downloads: [] };
      f.models.models.push({ id: modelId, name: entry.name, sizeBytes: source.sizeBytes, source });
      return {
        downloads: [{ ...initial, state: 'complete', downloadedBytes: source.sizeBytes, modelId }],
      };
    };
    const progress: string[] = [];
    const result = await f.ai.installModel!(entry.id, (event) => progress.push(event.phase)).done;
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.value.id, `llama-cpp:${modelId}`);
    assert.deepEqual(progress, ['resolving', 'downloading']);
  });
  it('rejects a changed resolved hash before starting a download', async () => {
    const f = fixture({ enabled: true });
    const entry = catalog[0];
    f.runtime.resolveModelSource = async () => ({
      source: { ...entry.source, sha256: 'a'.repeat(64), sizeBytes: 100 },
    });
    const result = await f.ai.installModel!(entry.id).done;
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /identity changed/);
  });
  it('cancels a download that starts after cancellation raced with source resolution', async () => {
    const f = fixture({ enabled: true });
    const entry = catalog[0];
    const source = { ...entry.source, sizeBytes: entry.approxSizeBytes };
    let resolve!: (value: {
      download: {
        id: string;
        source: typeof source;
        name: string;
        downloadedBytes: number;
        state: 'downloading';
      };
    }) => void;
    let started = false,
      cancelled = false;
    f.runtime.resolveModelSource = async () => ({ source });
    f.runtime.startModelDownload = async () => {
      started = true;
      return new Promise((r) => {
        resolve = r;
      });
    };
    f.runtime.cancelModelDownload = async () => {
      cancelled = true;
    };
    const handle = f.ai.installModel!(entry.id);
    while (!started) await tick();
    handle.cancel();
    resolve({
      download: {
        id: '11111111-1111-4111-8111-111111111111',
        source,
        name: entry.name,
        downloadedBytes: 0,
        state: 'downloading',
      },
    });
    const result = await handle.done;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'cancelled');
    assert.equal(cancelled, true);
  });
});

describe('mobile AI answer content', () => {
  it('keeps model reasoning out of both streamed and completed editor text', async () => {
    const f = fixture({ enabled: true });
    f.runtime.generate = async (input) => {
      f.emit(input.requestId, '<thi');
      f.emit(input.requestId, 'nk>internal</thi');
      f.emit(input.requestId, 'nk>\n\nTuesday.');
      return { text: '<think>internal</think>\n\nTuesday.', stopReason: 'stop' };
    };
    const events: AiChatEvent[] = [];
    const result = await f.ai.chat(request, (event) => events.push(event)).done;
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.value.text, 'Tuesday.');
    assert.equal(
      events
        .filter((event) => event.kind === 'delta')
        .map((event) => event.text)
        .join(''),
      'Tuesday.',
    );
  });
  it('reports an exhausted thinking budget without inserting empty text', async () => {
    const f = fixture({ enabled: true });
    f.runtime.generate = async () => ({ text: '<think>unfinished', stopReason: 'length' });
    const events: AiChatEvent[] = [];
    const result = await f.ai.chat(request, (event) => events.push(event)).done;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'budget-exceeded');
    assert.deepEqual(
      events.map((event) => event.kind),
      ['error'],
    );
  });
});
