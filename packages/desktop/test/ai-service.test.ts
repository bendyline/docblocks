import { expect } from 'chai';
import { AI_WIRE_LIMITS } from '@bendyline/docblocks/host';
import type {
  AiChatEvent,
  AiChatRequest,
  AiPreferences,
  AiStatus,
} from '@bendyline/docblocks/host';

import {
  AiService,
  DEFAULT_AI_PREFERENCES,
  type AiConnectOptions,
  type AiConnector,
  type AiDetection,
  type AiPreferenceStore,
  type AiProviderConnection,
  type AiServiceOptions,
  type ProviderChatChunk,
  type ProviderChatRequest,
} from '../main/ai/ai-service.js';
import type { ProviderModelEntry } from '../main/ai/ai-models.js';
import { AiHostError } from '../main/ai/ai-errors.js';

function sdkError(code: string): Error {
  return Object.assign(new Error(`provider said ${code}`), { code });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** An async stream the test feeds by hand, honouring abort like the SDK's. */
class ControlledStream implements AsyncIterable<ProviderChatChunk> {
  private readonly queue: ProviderChatChunk[] = [];
  private ended = false;
  private failure: unknown = null;
  private wake: (() => void) | null = null;

  constructor(private readonly signal: AbortSignal) {
    signal.addEventListener('abort', () => this.notify());
  }

  push(text: string, extra: Partial<ProviderChatChunk> = {}): void {
    this.queue.push({ text, finishReason: null, model: null, usage: null, ...extra });
    this.notify();
  }

  end(): void {
    this.ended = true;
    this.notify();
  }

  fail(error: unknown): void {
    this.failure = error;
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ProviderChatChunk> {
    for (;;) {
      if (this.signal.aborted) {
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      }
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

const MODEL_ENTRIES: ProviderModelEntry[] = [
  { id: 'gezel:writer', owned_by: 'gezel', name: 'Writer', is_fallback: true },
  { id: 'llama-cpp:qwen3-4b', owned_by: 'llama-cpp', context_window: 32_768 },
];

class FakeConnection implements AiProviderConnection {
  mode: AiProviderConnection['mode'] = 'installed';
  version?: string | null;
  prepare?: AiProviderConnection['prepare'];
  entries: ProviderModelEntry[] = MODEL_ENTRIES;
  closed = 0;
  revoked = 0;
  readonly streams: Array<{ request: ProviderChatRequest; stream: ControlledStream }> = [];

  async listModels(): Promise<readonly ProviderModelEntry[]> {
    return this.entries;
  }

  async streamChat(
    request: ProviderChatRequest,
    signal: AbortSignal,
  ): Promise<AsyncIterable<ProviderChatChunk>> {
    const stream = new ControlledStream(signal);
    this.streams.push({ request, stream });
    return stream;
  }

  async revoke(): Promise<void> {
    this.revoked += 1;
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

class FakeConnector implements AiConnector {
  readonly providerName = 'Gezel';
  detection: AiDetection = { installed: true, running: true, version: '1.1.2', canHost: false };
  detectGate: Promise<void> | null = null;
  detectCalls = 0;
  readonly connectCalls: AiConnectOptions[] = [];
  forgetCalls = 0;
  hasCredential = false;
  verificationCode = 'K7Q2XD';
  approvalGate: Promise<void> | null = null;
  approvalError: unknown = null;
  connection = new FakeConnection();

  async detect(): Promise<AiDetection> {
    this.detectCalls += 1;
    if (this.detectGate) await this.detectGate;
    return this.detection;
  }

  async connect(options: AiConnectOptions): Promise<AiProviderConnection> {
    this.connectCalls.push(options);
    if (!options.interactive) {
      // The real SDK refuses to register without a code handler.
      if (!this.hasCredential) throw sdkError('verification_code_handler_required');
      return this.connection;
    }
    options.onVerificationCode?.(this.verificationCode);
    if (this.approvalGate) await this.approvalGate;
    if (this.approvalError) throw this.approvalError;
    this.hasCredential = true;
    return this.connection;
  }

  async forget(): Promise<void> {
    this.forgetCalls += 1;
    this.hasCredential = false;
  }
}

class MemoryPreferences implements AiPreferenceStore {
  writes = 0;
  constructor(public value: AiPreferences) {}
  async read(): Promise<AiPreferences> {
    return this.value;
  }
  async write(preferences: AiPreferences): Promise<void> {
    this.value = preferences;
    this.writes += 1;
  }
}

const ENABLED: AiPreferences = { ...DEFAULT_AI_PREFERENCES, enabled: true };

const liveServices: AiService[] = [];

async function disposeLiveServices(): Promise<void> {
  await Promise.all(liveServices.splice(0).map((service) => service.dispose()));
}

function createService(
  preferences: AiPreferences,
  options: Partial<AiServiceOptions> = {},
): { service: AiService; connector: FakeConnector; store: MemoryPreferences } {
  const connector = new FakeConnector();
  const store = new MemoryPreferences(preferences);
  const service = new AiService({ connector, preferences: store, ...options });
  liveServices.push(service);
  return { service, connector, store };
}

async function readyService(
  options: Partial<AiServiceOptions> = {},
): Promise<{ service: AiService; connector: FakeConnector; store: MemoryPreferences }> {
  const created = createService(ENABLED, options);
  created.connector.hasCredential = true;
  await created.service.start();
  await settle();
  expect((await created.service.getStatus()).kind).to.equal('ready');
  return created;
}

function recorder(): { events: AiChatEvent[]; emit: (event: AiChatEvent) => void } {
  const events: AiChatEvent[] = [];
  return { events, emit: (event) => events.push(event) };
}

function terminalEvents(events: readonly AiChatEvent[]): AiChatEvent[] {
  return events.filter((event) => event.kind !== 'delta');
}

const WRITE_REQUEST: AiChatRequest = {
  messages: [{ role: 'user', content: 'Tighten this paragraph.' }],
  purpose: 'write',
};

describe('desktop AI service: connection', () => {
  afterEach(disposeLiveServices);

  it('does nothing at all while the user has not opted in', async () => {
    const { service, connector } = createService(DEFAULT_AI_PREFERENCES);
    await service.start();
    await settle();
    expect(await service.getStatus()).to.deep.equal({ kind: 'unavailable', reason: 'opt-out' });
    expect(connector.detectCalls).to.equal(0);
    expect(connector.connectCalls).to.have.length(0);
  });

  it('reconnects silently at startup with a stored grant', async () => {
    const { service, connector } = await readyService();
    expect(connector.connectCalls).to.have.length(1);
    expect(connector.connectCalls[0].interactive).to.equal(false);
    expect(connector.connectCalls[0].onVerificationCode).to.equal(undefined);
    const status = await service.getStatus();
    expect(status).to.deep.include({
      kind: 'ready',
      provider: { name: 'Gezel', version: '1.1.2', mode: 'installed' },
      activeRequests: 0,
    });
    if (status.kind === 'ready') expect(status.model?.id).to.equal('gezel:writer');
  });

  it('never prompts at startup when no grant is stored', async () => {
    const { service, connector } = createService(ENABLED);
    await service.start();
    await settle();
    expect(await service.getStatus()).to.deep.equal({
      kind: 'unavailable',
      reason: 'disconnected',
    });
    expect(connector.connectCalls.map((call) => call.interactive)).to.deep.equal([false]);
  });

  it('reports a missing or stopped provider without trying to connect', async () => {
    const missing = createService(ENABLED);
    missing.connector.detection = {
      installed: false,
      running: false,
      version: null,
      canHost: false,
    };
    await missing.service.start();
    await settle();
    expect(await missing.service.getStatus()).to.deep.equal({
      kind: 'unavailable',
      reason: 'not-installed',
    });

    const stopped = createService(ENABLED);
    stopped.connector.detection = {
      installed: true,
      running: false,
      version: null,
      canHost: false,
    };
    await stopped.service.start();
    await settle();
    expect(await stopped.service.getStatus()).to.deep.equal({
      kind: 'unavailable',
      reason: 'not-running',
    });
    expect(missing.connector.connectCalls).to.have.length(0);
    expect(stopped.connector.connectCalls).to.have.length(0);
  });

  it('looks for a stopped provider again when asked, but not on every read', async () => {
    let now = 0;
    const { service, connector } = createService(ENABLED, {
      now: () => now,
      redetectIntervalMs: 15_000,
    });
    connector.detection = { installed: true, running: false, version: null, canHost: false };
    await service.start();
    await settle();
    connector.detection = { installed: true, running: true, version: '1.1.2', canHost: false };
    connector.hasCredential = true;

    now = 5_000;
    expect((await service.getStatus()).kind).to.equal('unavailable');
    await settle();
    expect(connector.detectCalls).to.equal(1);

    now = 15_000;
    await service.getStatus();
    await settle();
    expect(connector.detectCalls).to.equal(2);
    expect((await service.getStatus()).kind).to.equal('ready');
  });

  it('refuses to connect while opted out', async () => {
    const { service, connector } = createService(DEFAULT_AI_PREFERENCES);
    const result = await service.connect();
    expect(result.ok).to.equal(false);
    if (!result.ok) expect(result.error.code).to.equal('provider-unavailable');
    expect(connector.detectCalls).to.equal(0);
  });

  it('shows the verification code while approval is pending, then becomes ready', async () => {
    const { service, connector } = createService(ENABLED);
    await service.start();
    await settle();
    const approval = deferred();
    connector.approvalGate = approval.promise;
    const seen: AiStatus[] = [];
    service.onStatus((status) => seen.push(status));

    const pending = service.connect();
    await settle();
    expect(await service.getStatus()).to.deep.equal({
      kind: 'connecting',
      step: 'awaiting-approval',
      verificationCode: 'K7Q2XD',
      progress: null,
    });
    approval.resolve();
    const result = await pending;
    expect(result.ok).to.equal(true);
    expect((await service.getStatus()).kind).to.equal('ready');
    expect(seen.map((status) => status.kind)).to.deep.equal(['connecting', 'connecting', 'ready']);
    expect(connector.hasCredential).to.equal(true);
  });

  it('lets a silent reconnect finish instead of prompting over it', async () => {
    const { service, connector } = createService(ENABLED);
    connector.hasCredential = true;
    const detected = deferred();
    connector.detectGate = detected.promise;
    await service.start();

    const connecting = service.connect();
    detected.resolve();
    const result = await connecting;
    expect(result.ok).to.equal(true);
    expect(connector.connectCalls.map((call) => call.interactive)).to.deep.equal([false]);
  });

  it('reports a declined connection as retryable', async () => {
    const { service, connector } = createService(ENABLED);
    await service.start();
    await settle();
    connector.approvalError = sdkError('user_denied');
    const result = await service.connect();
    expect(result.ok).to.equal(false);
    if (!result.ok) expect(result.error.code).to.equal('approval-denied');
    const status = await service.getStatus();
    expect(status.kind).to.equal('error');
    if (status.kind === 'error') {
      expect(status.retryable).to.equal(true);
      expect(status.error.message).to.equal('The connection was declined in Gezel.');
      expect(status.error.detail).to.equal('provider said user_denied');
    }
  });

  it('turning AI off closes the connection, keeps the grant, and stops detecting', async () => {
    const { service, connector, store } = await readyService();
    await service.setPreferences({ enabled: false });
    expect(await service.getStatus()).to.deep.equal({ kind: 'unavailable', reason: 'opt-out' });
    expect(connector.connection.closed).to.equal(1);
    expect(connector.connection.revoked).to.equal(0);
    expect(store.value.enabled).to.equal(false);

    const detections = connector.detectCalls;
    await service.getStatus();
    await settle();
    expect(connector.detectCalls).to.equal(detections);
  });

  it('turning AI on reconnects silently', async () => {
    const { service, connector } = createService(DEFAULT_AI_PREFERENCES);
    connector.hasCredential = true;
    await service.start();
    await service.setPreferences({ enabled: true });
    await settle();
    expect((await service.getStatus()).kind).to.equal('ready');
    expect(connector.connectCalls.map((call) => call.interactive)).to.deep.equal([false]);
  });

  it('follows the model preference, falling back to the default when it is gone', async () => {
    const { service } = await readyService();
    await service.setPreferences({ model: 'llama-cpp:qwen3-4b' });
    let status = await service.getStatus();
    if (status.kind !== 'ready') throw new Error('expected ready');
    expect(status.model).to.deep.equal({
      id: 'llama-cpp:qwen3-4b',
      label: 'qwen3-4b · llama-cpp',
      local: true,
      contextWindow: 32_768,
      isDefault: false,
    });

    await service.setPreferences({ model: 'ollama:removed' });
    status = await service.getStatus();
    if (status.kind !== 'ready') throw new Error('expected ready');
    expect(status.model?.id).to.equal('gezel:writer');
  });

  it('disconnect revokes the grant; without a connection it forgets the stored one', async () => {
    const { service, connector } = await readyService();
    const result = await service.disconnect();
    expect(result).to.deep.equal({ ok: true, value: null });
    expect(connector.connection.revoked).to.equal(1);
    expect(connector.connection.closed).to.equal(1);
    expect(await service.getStatus()).to.deep.equal({
      kind: 'unavailable',
      reason: 'disconnected',
    });

    const idle = createService(ENABLED);
    await idle.service.disconnect();
    expect(idle.connector.forgetCalls).to.equal(1);
  });
});

describe('desktop AI service: chat', () => {
  afterEach(disposeLiveServices);

  it('streams deltas and ends with exactly one done event', async () => {
    const { service, connector } = await readyService();
    const { events, emit } = recorder();
    service.startChat('1:a', WRITE_REQUEST, emit);
    await settle();
    const status = await service.getStatus();
    if (status.kind === 'ready') expect(status.activeRequests).to.equal(1);

    const { request, stream } = connector.connection.streams[0];
    expect(request.model).to.equal('gezel:writer');
    stream.push('Hel');
    stream.push('lo', {
      model: 'gezel:writer@2',
      usage: { promptTokens: 12, completionTokens: 2 },
    });
    stream.end();
    await settle();

    expect(events).to.deep.equal([
      { kind: 'delta', text: 'Hel' },
      { kind: 'delta', text: 'lo' },
      {
        kind: 'done',
        completion: {
          text: 'Hello',
          model: 'gezel:writer@2',
          finishReason: 'stop',
          usage: { promptTokens: 12, completionTokens: 2 },
        },
      },
    ]);
    expect(service.activeChatCount).to.equal(0);
    const after = await service.getStatus();
    if (after.kind === 'ready') expect(after.activeRequests).to.equal(0);
  });

  it('uses a model the request names over the preference', async () => {
    const { service, connector } = await readyService();
    service.startChat('1:a', { ...WRITE_REQUEST, model: 'llama-cpp:qwen3-4b' }, () => undefined);
    await settle();
    expect(connector.connection.streams[0].request.model).to.equal('llama-cpp:qwen3-4b');
  });

  it('a cancelled stream still ends once, with its partial text', async () => {
    const { service, connector } = await readyService();
    const { events, emit } = recorder();
    service.startChat('1:a', WRITE_REQUEST, emit);
    await settle();
    connector.connection.streams[0].stream.push('Partial');
    await settle();
    service.cancelChat('1:a');
    await settle();
    expect(terminalEvents(events)).to.deep.equal([
      {
        kind: 'done',
        completion: {
          text: 'Partial',
          model: 'gezel:writer',
          finishReason: 'cancelled',
          usage: null,
        },
      },
    ]);
  });

  it('times out a stream that stops producing', async () => {
    const { service } = await readyService({ streamIdleTimeoutMs: 20 });
    const { events, emit } = recorder();
    service.startChat('1:a', WRITE_REQUEST, emit);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle();
    expect(terminalEvents(events)).to.have.length(1);
    const [terminal] = terminalEvents(events);
    expect(terminal.kind).to.equal('error');
    if (terminal.kind === 'error') expect(terminal.error.code).to.equal('timeout');
  });

  it('caps a runaway completion and says so', async () => {
    const { service, connector } = await readyService();
    const { events, emit } = recorder();
    service.startChat('1:a', WRITE_REQUEST, emit);
    await settle();
    connector.connection.streams[0].stream.push(
      'x'.repeat(AI_WIRE_LIMITS.completionCharacters + 10),
    );
    await settle();
    const deltas = events.filter((event) => event.kind === 'delta');
    for (const delta of deltas) {
      if (delta.kind === 'delta') {
        expect(delta.text.length).to.be.at.most(AI_WIRE_LIMITS.deltaCharacters);
      }
    }
    const [terminal] = terminalEvents(events);
    expect(terminal.kind).to.equal('done');
    if (terminal.kind === 'done') {
      expect(terminal.completion.finishReason).to.equal('length');
      expect(terminal.completion.text).to.have.length(AI_WIRE_LIMITS.completionCharacters);
    }
  });

  it('splits a large delta without separating a surrogate pair', async () => {
    const { service, connector } = await readyService();
    const { events, emit } = recorder();
    service.startChat('1:a', WRITE_REQUEST, emit);
    await settle();
    const text = `${'a'.repeat(AI_WIRE_LIMITS.deltaCharacters - 1)}😀b`;
    connector.connection.streams[0].stream.push(text);
    connector.connection.streams[0].stream.end();
    await settle();
    const deltas = events.flatMap((event) => (event.kind === 'delta' ? [event.text] : []));
    expect(deltas.join('')).to.equal(text);
    for (const delta of deltas) {
      const last = delta.charCodeAt(delta.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).to.equal(false);
    }
  });

  it('refuses a request past the concurrency budget', async () => {
    const { service } = await readyService({ maxConcurrentChats: 1 });
    service.startChat('1:a', WRITE_REQUEST, () => undefined);
    const { events, emit } = recorder();
    service.startChat('1:b', WRITE_REQUEST, emit);
    expect(events).to.have.length(1);
    const [terminal] = events;
    if (terminal.kind === 'error') expect(terminal.error.code).to.equal('budget-exceeded');
    else expect.fail('expected an error event');
  });

  it('refuses a request while not connected', () => {
    const { service } = createService(DEFAULT_AI_PREFERENCES);
    const { events, emit } = recorder();
    service.startChat('1:a', WRITE_REQUEST, emit);
    expect(events).to.have.length(1);
    const [terminal] = events;
    if (terminal.kind === 'error') expect(terminal.error.code).to.equal('provider-unavailable');
    else expect.fail('expected an error event');
  });

  it('reflects a provider that vanishes mid-stream in the status', async () => {
    const { service, connector } = await readyService();
    const { events, emit } = recorder();
    service.startChat('1:a', WRITE_REQUEST, emit);
    await settle();
    connector.connection.streams[0].stream.fail(sdkError('daemon_not_running'));
    await settle();
    const [terminal] = terminalEvents(events);
    if (terminal.kind === 'error') expect(terminal.error.code).to.equal('provider-unavailable');
    else expect.fail('expected an error event');
    expect(await service.getStatus()).to.deep.equal({
      kind: 'unavailable',
      reason: 'not-running',
    });
    expect(connector.connection.closed).to.equal(1);
  });

  it('turning AI off mid-stream ends the stream exactly once', async () => {
    const { service } = await readyService();
    const { events, emit } = recorder();
    service.startChat('1:a', WRITE_REQUEST, emit);
    await settle();
    await service.setPreferences({ enabled: false });
    await settle();
    const terminal = terminalEvents(events);
    expect(terminal).to.have.length(1);
    if (terminal[0].kind === 'error') expect(terminal[0].error.code).to.equal('cancelled');
    else expect.fail('expected an error event');
  });
});

describe('desktop AI service: hosting', () => {
  afterEach(disposeLiveServices);

  function hostingService(
    entries: ProviderModelEntry[] = [
      { id: 'llama-cpp:qwen3.8-27b-q4', owned_by: 'llama-cpp', context_window: 262_144 },
    ],
  ) {
    const created = createService(ENABLED);
    created.connector.detection = {
      installed: false,
      running: false,
      version: null,
      canHost: true,
    };
    // The fake hands back its connection silently; the connector's own
    // ladder (tested separately) is what decides to host.
    created.connector.hasCredential = true;
    created.connector.connection.mode = 'hosted';
    created.connector.connection.version = '1.1.2';
    created.connector.connection.entries = entries;
    return created;
  }

  it('hosts when no Gezel is installed, as long as it can', async () => {
    const { service } = hostingService();
    await service.start();
    await settle();
    const status = await service.getStatus();
    expect(status).to.deep.include({
      kind: 'ready',
      provider: { name: 'Gezel', version: '1.1.2', mode: 'hosted' },
    });
    if (status.kind === 'ready') {
      expect(status.model).to.deep.include({ id: 'llama-cpp:qwen3.8-27b-q4', local: true });
    }
  });

  it('shows engine progress while a hosted provider prepares its model', async () => {
    const { service, connector } = hostingService();
    const engineReady = deferred();
    const prepared: string[] = [];
    connector.connection.prepare = async (modelId, onProgress) => {
      prepared.push(modelId);
      onProgress({ phase: 'engine', message: 'downloading the llama-server engine', percent: 40 });
      await engineReady.promise;
    };
    await service.start();
    await settle();

    expect(await service.getStatus()).to.deep.equal({
      kind: 'connecting',
      step: 'preparing-model',
      verificationCode: null,
      progress: { phase: 'engine', message: 'downloading the llama-server engine', percent: 40 },
    });
    engineReady.resolve();
    await settle();
    expect((await service.getStatus()).kind).to.equal('ready');
    expect(prepared).to.deep.equal(['llama-cpp:qwen3.8-27b-q4']);
  });

  it('reports a hosted provider with no on-device model, and stops it', async () => {
    const { service, connector } = hostingService([]);
    await service.start();
    await settle();
    const status = await service.getStatus();
    expect(status.kind).to.equal('error');
    if (status.kind === 'error') {
      expect(status.error.code).to.equal('model-unavailable');
      expect(status.retryable).to.equal(true);
    }
    expect(connector.connection.closed).to.equal(1);
  });

  it('leaves no daemon running when preparation fails', async () => {
    const { service, connector } = hostingService();
    connector.connection.prepare = async () => {
      throw new AiHostError('model-unavailable', 'not installed');
    };
    await service.start();
    await settle();
    const status = await service.getStatus();
    expect(status.kind).to.equal('error');
    if (status.kind === 'error') expect(status.error.message).to.equal('not installed');
    expect(connector.connection.closed).to.equal(1);
  });
});
