import assert from 'node:assert/strict';
import {
  connectEmbeddingRuntime,
  mobileCatalog,
  type GezelRuntimePlugin,
} from '@bendyline/gezel-capacitor';
import type {
  MobileModelDownload,
  MobileModelInventory,
  MobileProvider,
} from '@bendyline/gezel/mobile-providers';
import type { AiChatEvent, AiPreferences } from '@bendyline/docblocks/host';
import type { EmbeddingConnection } from '@bendyline/gezel-app-sdk/browser';
import { createMobileAi } from '../src/ai/host';
import { buildReviewRequest } from '../../react/src/Ai/ai-assistant';
import { WELCOME_DOCUMENT_CONTENT } from '../../react/src/DocBlocksShell/welcome-document';
const catalog = mobileCatalog.map((model) => ({
  ...model,
  id: `catalog:${model.source.catalogId}`,
}));
const request = {
  purpose: 'write' as const,
  messages: [{ role: 'user' as const, content: 'Hello' }],
  temperature: 0.7,
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function fixture(initial: Partial<AiPreferences> = {}, downloadRetryDelaysMs = [1, 1, 1]) {
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
    addListener: async (event, listener) => {
      if (event === 'chatDelta') emit = listener as typeof emit;
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
    return connectEmbeddingRuntime(runtime, { pollIntervalMs: 10 });
  };
  const host = createMobileAi({
    load: () => load(),
    readPreferences: () => preferences,
    writePreferences: (value) => {
      preferences = value;
    },
    requestTimeoutMs: 40,
    downloadRetryDelaysMs,
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
  it('leaves native reply capacity for the editor answer when reasoning controls are supported', async () => {
    const f = fixture({ enabled: true });
    f.providers[0].capabilities.structuredChat = true;
    let emit: (event: unknown) => void = () => {};
    f.runtime.addListener = async (name, listener) => {
      if (name === 'chatChunk') emit = listener as typeof emit;
      return { remove: async () => {} };
    };
    let body: Record<string, unknown> | undefined;
    f.runtime.chat = async (input) => {
      body = JSON.parse(input.requestJson);
      emit({
        requestId: input.requestId,
        chunks: [
          JSON.stringify({
            choices: [{ index: 0, delta: { content: '[]' }, finish_reason: 'stop' }],
          }),
        ],
      });
      return { status: 'ok' };
    };
    const result = await f.ai.chat(buildReviewRequest(WELCOME_DOCUMENT_CONTENT), () => {}).done;
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(body?.reasoning_effort, 'none');
    assert.equal(result.value.text, '[]');
    assert.ok(!f.calls.includes('generate'));
    const written = await f.ai.chat(request, () => {}).done;
    assert.ok(written.ok, JSON.stringify(written));
    assert.equal(body?.reasoning_effort, 'none');
  });

  it('reviews the welcome document with the reply and context budgets the native model supports', async () => {
    const f = fixture({ enabled: true });
    f.providers[0].contextTokens = 16384;
    f.providers[0].maxOutputTokens = 4096;
    f.models.models[0].contextTokens = 8192;
    let routed: Parameters<GezelRuntimePlugin['generate']>[0] | undefined;
    f.runtime.generate = async (input) => {
      routed = input;
      return { text: '[]', stopReason: 'stop' };
    };
    const result = await f.ai.chat(buildReviewRequest(WELCOME_DOCUMENT_CONTENT), () => {}).done;
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(routed?.contextSize, 8192);
    assert.equal(routed?.maxTokens, 4096);
    assert.ok(routed?.messages.at(-1)?.content.includes(WELCOME_DOCUMENT_CONTENT));
  });

  it('uses native output capacity for writing without a caller cap', async () => {
    const f = fixture();
    let routed: Parameters<GezelRuntimePlugin['generate']>[0] | undefined;
    f.runtime.generate = async (input) => {
      routed = input;
      return { text: 'Complete draft.', stopReason: 'stop' };
    };
    await f.ai.setPreferences({ enabled: true });
    const result = await f.ai.chat(request, () => {}).done;
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(routed?.maxTokens, 2048);
  });

  for (const [providerId, label] of [
    ['apple-foundation-models', 'Apple Foundation Models'],
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
      assert.ok(result.ok, JSON.stringify(result));
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

  for (const availability of ['available', 'download-required', 'unavailable'] as const) {
    it(`never offers, prepares or routes to ML Kit (${availability})`, async () => {
      const modelId = 'android-mlkit:android-mlkit';
      const f = fixture({ enabled: true, model: modelId });
      f.providers.push({ ...f.providers[0], id: 'android-mlkit', availability });
      const models = await f.ai.models();
      assert.ok(models.ok);
      if (models.ok)
        assert.deepEqual(
          models.value.map((m) => m.id),
          ['llama-cpp:fixture'],
        );
      const available = await f.ai.availableModels!();
      assert.ok(available.ok);
      if (available.ok) assert.ok(!available.value.some((m) => m.id === modelId));
      const installed = await f.ai.installModel!(modelId).done;
      assert.ok(!installed.ok);
      if (!installed.ok) assert.equal(installed.error.code, 'model-unavailable');
      const result = await f.ai.chat(request, () => {}).done;
      assert.ok(!result.ok);
      if (!result.ok) assert.equal(result.error.code, 'model-unavailable');
      assert.ok(!f.calls.includes('generate'));
    });
  }

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
    assert.equal(f.ai.images, undefined);
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
    assert.ok(result.ok, JSON.stringify(result));
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
        assert.ok(result.ok, JSON.stringify(result));
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
      return connectEmbeddingRuntime(f.runtime);
    });
    const enabling = f.ai.setPreferences({ enabled: true });
    while (!release) await tick();
    const disabling = f.ai.setPreferences({ enabled: false });
    release();
    await Promise.all([enabling, disabling]);
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
      if (!f.models.models.some((model) => model.id === modelId))
        f.models.models.push({
          id: modelId,
          name: entry.name,
          sizeBytes: source.sizeBytes,
          source,
        });
      return {
        downloads: [{ ...initial, state: 'complete', downloadedBytes: source.sizeBytes, modelId }],
      };
    };
    const progress: string[] = [];
    const result = await f.ai.installModel!(entry.id, (event) => progress.push(event.phase)).done;
    assert.ok(result.ok, JSON.stringify(result));
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

  // Each native attempt saves `step` more bytes, then fails with the next
  // scripted error; once the errors run out, the download completes.
  function flakyDownload(f: ReturnType<typeof fixture>, errors: string[], step = 100) {
    const entry = catalog[0];
    const source = { ...entry.source, sizeBytes: entry.approxSizeBytes };
    const id = '11111111-1111-4111-8111-111111111111';
    const modelId = '22222222-2222-4222-8222-222222222222';
    let record: MobileModelDownload | undefined;
    const native = { resumes: 0 };
    const attempt = (downloadedBytes: number) => {
      record = { id, source, name: entry.name, downloadedBytes, state: 'downloading' };
      return { download: record };
    };
    f.runtime.resolveModelSource = async () => ({ source });
    f.runtime.startModelDownload = async () => attempt(0);
    f.runtime.resumeModelDownload = async (input) => {
      assert.equal(input.id, id);
      native.resumes++;
      return attempt(record!.downloadedBytes);
    };
    f.runtime.listModelDownloads = async () => {
      if (record?.state === 'downloading') {
        const error = errors.shift();
        if (error === undefined) {
          f.models.models.push({
            id: modelId,
            name: entry.name,
            sizeBytes: source.sizeBytes,
            source,
          });
          record = { ...record, state: 'complete', downloadedBytes: source.sizeBytes, modelId };
        } else
          record = {
            ...record,
            state: 'failed',
            downloadedBytes: record.downloadedBytes + step,
            error,
          };
      }
      return { downloads: record ? [record] : [] };
    };
    return { entry, native, modelId };
  }
  it('resumes an interrupted download until the model is installed', async () => {
    const f = fixture({ enabled: true });
    // More interruptions than retries: each one saved bytes, so none exhausts the budget.
    const { entry, native, modelId } = flakyDownload(f, [
      'unexpected end of stream',
      'Software caused connection abort',
      'Model download failed (HTTP 503)',
      'The network connection was lost.',
      'Model transfer ended early. Resume to continue.',
    ]);
    const progress: string[] = [];
    const result = await f.ai.installModel!(entry.id, (event) => progress.push(event.phase)).done;
    assert.ok(result.ok, JSON.stringify(result));
    if (result.ok) assert.equal(result.value.id, `llama-cpp:${modelId}`);
    assert.equal(native.resumes, 5);
    assert.equal(progress.filter((phase) => phase === 'retrying').length, 5);
  });
  it('gives up in plain language when retries save nothing', async () => {
    const f = fixture({ enabled: true });
    const { entry, native } = flakyDownload(f, Array(10).fill('unexpected end of stream'), 0);
    const result = await f.ai.installModel!(entry.id).done;
    assert.equal(native.resumes, 3);
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.error.code, 'model-download-failed');
      assert.match(result.error.message, /interrupted.*continue where it stopped/);
      assert.equal(result.error.detail, 'unexpected end of stream');
    }
  });
  for (const [error, message] of [
    ['Model SHA-256 verification failed. No model was installed.', /damaged/],
    ['Model download failed (HTTP 404)', /could not be downloaded/],
    [
      'Model source changed its resume identity or byte range; remove this download and try again',
      /could not be downloaded/,
    ],
  ] as const) {
    it(`does not retry a failure resuming would repeat: ${error}`, async () => {
      const f = fixture({ enabled: true });
      const { entry, native } = flakyDownload(f, [error]);
      const result = await f.ai.installModel!(entry.id).done;
      assert.equal(native.resumes, 0);
      assert.ok(!result.ok);
      if (!result.ok) {
        assert.equal(result.error.code, 'model-download-failed');
        assert.match(result.error.message, message);
        assert.equal(result.error.detail, error);
      }
    });
  }
  it('cancels while waiting to retry without touching the saved download', async () => {
    const f = fixture({ enabled: true }, [60_000]);
    const { entry, native } = flakyDownload(f, ['unexpected end of stream']);
    const handle = f.ai.installModel!(entry.id, (event) => {
      if (event.phase === 'retrying') handle.cancel();
    });
    const result = await handle.done;
    assert.ok(!result.ok);
    if (!result.ok) assert.equal(result.error.code, 'cancelled');
    assert.equal(native.resumes, 0);
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
    assert.ok(result.ok, JSON.stringify(result));
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

describe('mobile AI shared progress', () => {
  it('forwards scoped engine progress to the same host events used by desktop', async () => {
    const f = fixture({ enabled: true });
    const listeners = new Map<string, (event: unknown) => void>();
    f.runtime.addListener = async (name, listener) => {
      listeners.set(name, listener as (event: unknown) => void);
      return {
        remove: async () => {
          listeners.delete(name);
        },
      };
    };
    f.runtime.generate = async ({ requestId }) => {
      listeners.get('enginePhase')?.({ requestId: 'stale', phase: 'loading_model', progress: 1 });
      listeners.get('enginePhase')?.({ requestId, phase: 'loading_model', progress: 0.5 });
      listeners.get('enginePhase')?.({ requestId, phase: 'generating', outputTokens: 4 });
      return { text: 'Done.', stopReason: 'stop' };
    };
    const events: AiChatEvent[] = [];
    const result = await f.ai.chat(request, (event) => events.push(event)).done;
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(
      events.filter((event) => event.kind === 'progress').map((event) => event.progress),
      [
        { phase: 'loading_model', percent: 50, outputTokens: null, tokensPerSecond: null },
        { phase: 'generating', percent: null, outputTokens: 4, tokensPerSecond: null },
      ],
    );
    assert.equal(listeners.size, 0);
    assert.equal(
      events.filter((event) => event.kind === 'done' || event.kind === 'error').length,
      1,
    );
    await f.ai.setPreferences({ enabled: false });
  });
});

describe('mobile knowledge', () => {
  type Knowledge = NonNullable<EmbeddingConnection['knowledge']>;
  type Action = Parameters<Knowledge['update']>[0];
  const passage = {
    uri: `knowledge://bendyline/regional-pacific-northwest/panama-hotel#chunk=${'0'.repeat(32)}`,
    title: 'Panama Hotel (Seattle)',
    text: 'The Panama Hotel opened in 1910.',
    catalogId: 'regional-pacific-northwest',
    version: '2026.10.5',
  };
  const catalog = {
    id: 'regional-pacific-northwest',
    name: 'Pacific Northwest',
    description: '',
    version: '2026.10.5',
    installedVersion: '2026.10.5',
    enabled: true,
    updateAvailable: false,
    downloadBytes: 1,
    documents: 1,
    state: 'installed' as const,
    percent: null,
    message: null,
  };
  function withKnowledge(overrides: Partial<Knowledge> = {}) {
    const f = fixture({ enabled: true });
    const updates: Action[] = [];
    const queries: string[] = [];
    let stateCalls = 0;
    const knowledge: Knowledge = {
      state: async () => {
        stateCalls++;
        return {
          catalogs: [catalog],
          reranker: { ready: false, downloading: false, message: null },
          improvement: null,
        };
      },
      update: async (action) => {
        updates.push(action);
      },
      retrieve: async (query) => {
        queries.push(query.query);
        return { reranked: false, passages: [passage] };
      },
      ...overrides,
    };
    f.setLoad(async () => ({
      ...(await connectEmbeddingRuntime(f.runtime, { pollIntervalMs: 10 })),
      knowledge,
    }));
    return { ...f, updates, queries, stateCalls: () => stateCalls };
  }

  it('lists catalogs and maps the improvement action to the SDK', async () => {
    const f = withKnowledge();
    const state = await f.ai.knowledge.state();
    assert.ok(state.ok, JSON.stringify(state));
    assert.deepEqual(state.value, { catalogs: [catalog], improvement: null });
    assert.deepEqual(await f.ai.knowledge.update({ action: 'improve' }), { ok: true, value: null });
    assert.deepEqual(await f.ai.knowledge.update({ action: 'install', catalogId: catalog.id }), {
      ok: true,
      value: null,
    });
    assert.deepEqual(f.updates, [
      { action: 'prepare-reranker' },
      { action: 'install', catalogId: catalog.id },
    ]);
    await f.ai.setPreferences({ enabled: false });
  });

  it('reports a refused catalog action as a failed result', async () => {
    const f = withKnowledge({
      update: async () => {
        throw Object.assign(new Error('Better knowledge results are not available'), {
          code: 'unsupported',
        });
      },
    });
    const result = await f.ai.knowledge.update({ action: 'improve' });
    assert.equal(result.ok, false);
    await f.ai.setPreferences({ enabled: false });
  });

  it('grounds a request in retrieved passages and names their catalog', async () => {
    const f = withKnowledge();
    let routed: Parameters<GezelRuntimePlugin['generate']>[0] | undefined;
    f.runtime.generate = async (input) => {
      routed = input;
      return { text: 'It opened in 1910.', stopReason: 'stop' };
    };
    const events: AiChatEvent[] = [];
    const result = await f.ai.chat(
      {
        purpose: 'write',
        messages: [{ role: 'user', content: 'Tell me about the Panama Hotel.' }],
        knowledgeQuery: 'Panama Hotel',
      },
      (event) => events.push(event),
    ).done;
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(f.queries, ['Panama Hotel']);
    assert.ok(routed?.messages.some((message) => message.content.includes(passage.text)));
    // No catalog listing ran first: the request looks the name up itself.
    const knowledge = events.find((event) => event.kind === 'knowledge');
    assert.deepEqual(knowledge?.kind === 'knowledge' && knowledge.knowledge, {
      outcome: 'used',
      sources: [{ catalogId: catalog.id, name: 'Pacific Northwest', titles: [passage.title] }],
      evidence: [{ title: passage.title, catalogId: catalog.id, text: passage.text }],
    });
    // The names stay cached for the next request.
    const calls = f.stateCalls();
    assert.ok((await f.ai.chat(request, () => {}).done).ok);
    assert.equal(f.stateCalls(), calls);
    await f.ai.setPreferences({ enabled: false });
  });

  it('answers without passages when retrieval fails', async () => {
    const f = withKnowledge({
      retrieve: async () => {
        throw new Error('The knowledge worker stopped');
      },
    });
    let routed: Parameters<GezelRuntimePlugin['generate']>[0] | undefined;
    f.runtime.generate = async (input) => {
      routed = input;
      return { text: 'Hello!', stopReason: 'stop' };
    };
    const events: AiChatEvent[] = [];
    const result = await f.ai.chat(request, (event) => events.push(event)).done;
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(routed?.messages.at(-1)?.content, 'Hello');
    const knowledge = events.find((event) => event.kind === 'knowledge');
    assert.ok(knowledge?.kind === 'knowledge' && knowledge.knowledge.outcome !== 'used');
    await f.ai.setPreferences({ enabled: false });
  });
});
