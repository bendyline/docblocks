/**
 * The real Gezel app SDK against a fake daemon.
 *
 * These pin the SDK behaviour DocBlocks' safety rests on — above all that a
 * silent reconnect can never register a new grant, which is what would raise
 * a consent prompt in Gezel with no user gesture behind it. An SDK upgrade
 * that changed that ordering must fail here, not in someone's Gezel window.
 */

import { expect } from 'chai';

import { toAiError } from '../main/ai/ai-errors.js';
import { GezelConnector, type AiCredentialStore } from '../main/ai/gezel-connector.js';
import type { ProviderChatChunk } from '../main/ai/ai-service.js';

const BASE_URL = 'https://127.0.0.1:59999';

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly bearer: string | null;
  readonly body: unknown;
}

class MemoryCredentials implements AiCredentialStore {
  deletes = 0;
  constructor(public token: string | null = null) {}
  async load(): Promise<string | null> {
    return this.token;
  }
  async save(token: string): Promise<void> {
    this.token = token;
  }
  async delete(): Promise<void> {
    this.token = null;
    this.deletes += 1;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sse(events: readonly unknown[]): Response {
  const text = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

class FakeDaemon {
  validToken: string | null = null;
  decision: 'approved' | 'denied' = 'approved';
  knowledgePassages: unknown[] = [];
  readonly requests: RecordedRequest[] = [];

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const authorization = new Headers(init?.headers).get('authorization');
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    this.requests.push({ method, path: url.pathname, bearer, body });

    if (method === 'POST' && url.pathname === '/v1/apps/register') {
      return json(200, {
        status: 'pending',
        grantRequestId: 'grant-1',
        verificationRequired: true,
        verificationCode: 'K7Q2XD',
      });
    }
    if (method === 'GET' && url.pathname === '/v1/apps/grant/grant-1') {
      if (this.decision === 'denied') return json(200, { status: 'denied' });
      this.validToken = 'issued-token';
      return json(200, { status: 'approved', token: 'issued-token' });
    }

    if (bearer === null || bearer !== this.validToken) {
      return json(401, { error: { code: 'unauthorized', message: 'Unknown token' } });
    }
    if (method === 'GET' && url.pathname === '/v1/models') {
      return json(200, {
        object: 'list',
        data: [
          { id: 'gezel:writer', object: 'model', created: 1, owned_by: 'gezel', is_fallback: true },
        ],
      });
    }
    if (method === 'GET' && url.pathname === '/v1/knowledge/state') {
      return json(200, {
        catalogs: [],
        reranker: { ready: true, downloading: false, message: null },
      });
    }
    if (method === 'POST' && url.pathname === '/v1/knowledge/retrieve') {
      return json(200, { reranked: true, passages: this.knowledgePassages });
    }
    if (method === 'POST' && url.pathname === '/v1/models/ensure') {
      return json(202, {
        status: 'downloading',
        model_id: 'llama-cpp:small-writer',
        job_id: 'install-1',
      });
    }
    if (method === 'GET' && url.pathname === '/v1/models/ensure/install-1/events') {
      return sse([
        {
          type: 'progress',
          jobId: 'install-1',
          modelId: 'llama-cpp:small-writer',
          bytesWritten: 25,
          totalBytes: 100,
        },
        {
          type: 'done',
          jobId: 'install-1',
          modelId: 'llama-cpp:small-writer',
        },
      ]);
    }
    if (method === 'POST' && url.pathname === '/v1/chat/completions') {
      const chunk = (content: string | undefined, finish: string | null, usage?: unknown) => ({
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gezel:writer',
        choices: [
          { index: 0, delta: content === undefined ? {} : { content }, finish_reason: finish },
        ],
        ...(usage ? { usage } : {}),
      });
      return sse([
        chunk('Hel', null),
        chunk('lo', null),
        chunk(undefined, 'stop', { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 }),
      ]);
    }
    if (method === 'DELETE' && url.pathname === '/v1/apps/docblocks/token') {
      this.validToken = null;
      return new Response(null, { status: 204 });
    }
    return json(404, { error: { code: 'not_found', message: 'No route' } });
  };

  paths(): string[] {
    return this.requests.map((request) => `${request.method} ${request.path}`);
  }
}

function connectorFor(daemon: FakeDaemon, credentials: MemoryCredentials): GezelConnector {
  return new GezelConnector({ credentials, endpoint: { baseUrl: BASE_URL, fetch: daemon.fetch } });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

describe('Gezel connector against the app SDK', () => {
  it('a silent reconnect without a stored grant never registers one', async () => {
    const daemon = new FakeDaemon();
    const error = await rejection(
      connectorFor(daemon, new MemoryCredentials()).connect({ interactive: false }),
    );
    expect(toAiError(error).code).to.equal('approval-required');
    expect(daemon.paths()).to.not.include('POST /v1/apps/register');
  });

  it('a silent reconnect with a stale grant neither registers nor revokes', async () => {
    const daemon = new FakeDaemon();
    const credentials = new MemoryCredentials('stale-token');
    const error = await rejection(
      connectorFor(daemon, credentials).connect({ interactive: false }),
    );
    expect(toAiError(error).code).to.equal('approval-required');
    expect(daemon.paths()).to.deep.equal(['GET /v1/models']);
    expect(credentials.token).to.equal('stale-token');
  });

  it('a silent reconnect reuses a valid stored grant', async () => {
    const daemon = new FakeDaemon();
    daemon.validToken = 'kept-token';
    const connection = await connectorFor(daemon, new MemoryCredentials('kept-token')).connect({
      interactive: false,
    });
    expect(connection.mode).to.equal('installed');
    expect(await connection.listModels()).to.deep.equal([
      { id: 'gezel:writer', object: 'model', created: 1, owned_by: 'gezel', is_fallback: true },
    ]);
    expect(daemon.paths()).to.not.include('POST /v1/apps/register');
  });

  it('an interactive connect asks for inference and catalog authority with a typed code', async () => {
    const daemon = new FakeDaemon();
    const credentials = new MemoryCredentials();
    const codes: string[] = [];
    const connection = await connectorFor(daemon, credentials).connect({
      interactive: true,
      onVerificationCode: (code) => codes.push(code),
    });

    expect(codes).to.deep.equal(['K7Q2XD']);
    const register = daemon.requests.find((request) => request.path === '/v1/apps/register');
    expect(register?.body).to.deep.equal({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai', 'knowledge'],
      requireVerificationCode: true,
    });
    expect(credentials.token).to.equal('issued-token');
    expect(await connection.listModels()).to.have.length(1);
  });

  it('a declined connection stores nothing', async () => {
    const daemon = new FakeDaemon();
    daemon.decision = 'denied';
    const credentials = new MemoryCredentials();
    const error = await rejection(
      connectorFor(daemon, credentials).connect({
        interactive: true,
        onVerificationCode: () => undefined,
      }),
    );
    expect(toAiError(error).code).to.equal('approval-denied');
    expect(credentials.token).to.equal(null);
  });

  it('adapts a streamed completion', async () => {
    const daemon = new FakeDaemon();
    daemon.validToken = 'kept-token';
    const connection = await connectorFor(daemon, new MemoryCredentials('kept-token')).connect({
      interactive: false,
    });
    const stream = await connection.streamChat(
      {
        model: 'gezel:writer',
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 64,
        temperature: 0.2,
      },
      new AbortController().signal,
    );
    const chunks: ProviderChatChunk[] = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks.map((chunk) => chunk.text).join('')).to.equal('Hello');
    expect(chunks.at(-1)).to.deep.equal({
      text: '',
      finishReason: 'stop',
      model: 'gezel:writer',
      usage: { promptTokens: 9, completionTokens: 2 },
    });
    const request = daemon.requests.find((entry) => entry.path === '/v1/chat/completions');
    expect(request?.body).to.deep.equal({
      model: 'gezel:writer',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
      reasoning_effort: 'none',
      temperature: 0.2,
      max_tokens: 64,
    });
  });

  it('sends retrieved, cited knowledge through the real SDK completion request', async () => {
    const daemon = new FakeDaemon();
    daemon.validToken = 'kept-token';
    const source = 'knowledge://publisher/science/article';
    daemon.knowledgePassages = [
      {
        uri: source,
        title: 'Science',
        text: 'A relevant fact.',
        catalogId: 'science',
        version: '1',
      },
    ];
    const connection = await connectorFor(daemon, new MemoryCredentials('kept-token')).connect({
      interactive: false,
    });
    const stream = await connection.streamChat(
      { model: 'gezel:writer', messages: [{ role: 'user', content: 'Explain science.' }] },
      new AbortController().signal,
    );
    for await (const chunk of stream) expect(chunk.model).to.equal('gezel:writer');
    const retrieval = daemon.requests.find((entry) => entry.path === '/v1/knowledge/retrieve');
    // The SDK picks the ranking mode; DocBlocks only asks.
    expect(retrieval?.body).to.include({ query: 'Explain science.' });
    const completion = daemon.requests.find((entry) => entry.path === '/v1/chat/completions');
    const body = completion?.body as {
      messages: Array<{ role: string; content: string }>;
      reasoning_effort?: string;
    };
    // No DocBlocks surface shows reasoning, so thinking is turned off.
    expect(body.reasoning_effort).to.equal('none');
    expect(body.messages[0].role).to.equal('system');
    expect(body.messages[0].content).to.contain(source).and.contain('A relevant fact.');
    expect(body.messages[1]).to.deep.equal({ role: 'user', content: 'Explain science.' });
  });

  it('downloads a model only when the caller explicitly requests it', async () => {
    const daemon = new FakeDaemon();
    daemon.validToken = 'kept-token';
    const connection = await connectorFor(daemon, new MemoryCredentials('kept-token')).connect({
      interactive: false,
    });
    const progress: unknown[] = [];
    await connection.installModel?.(
      'llama-cpp:small-writer',
      new AbortController().signal,
      (event) => progress.push(event),
    );
    expect(daemon.paths()).to.include.members([
      'POST /v1/models/ensure',
      'GET /v1/models/ensure/install-1/events',
    ]);
    expect(progress).to.deep.equal([
      { phase: 'weights', message: 'Downloading llama-cpp:small-writer…', percent: null },
      { phase: 'weights', message: 'Downloading llama-cpp:small-writer…', percent: 25 },
      { phase: 'ready', message: 'Model is ready.', percent: 100 },
    ]);
  });

  it('revoke withdraws the grant and forgets it locally', async () => {
    const daemon = new FakeDaemon();
    daemon.validToken = 'kept-token';
    const credentials = new MemoryCredentials('kept-token');
    const connection = await connectorFor(daemon, credentials).connect({ interactive: false });
    await connection.revoke();
    expect(daemon.paths()).to.include('DELETE /v1/apps/docblocks/token');
    expect(credentials.token).to.equal(null);
  });

  it('reports a missing SDK as a missing runtime', async () => {
    const connector = new GezelConnector({
      credentials: new MemoryCredentials(),
      loadSdk: () =>
        Promise.reject(
          Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' }),
        ),
    });
    const error = await rejection(connector.detect());
    expect(toAiError(error).code).to.equal('runtime-missing');
  });
});

describe('Gezel connector hosting ladder', () => {
  const RUNTIME = {
    nodePath: '/opt/docblocks/gezel-host/node/node',
    daemonEntry: '/opt/docblocks/gezel-host/service/dist/bin/gezeld.js',
    nativeBinDir: '/opt/docblocks/gezel-host/native-bin',
    version: '1.1.2',
    source: 'bundled' as const,
  };

  function refusal(code: string, status?: number): Error {
    return Object.assign(new Error(`gezel said ${code}`), { code, ...(status ? { status } : {}) });
  }

  interface HostCall {
    readonly adoptUserDaemon?: boolean;
    readonly host?: Record<string, unknown>;
  }

  function fakeHostedGezel(
    options: {
      models?: Array<{ id: string; owned_by?: string }>;
      ensureModel?: (opts: {
        allowWeightDownload?: boolean;
        onEvent?: (event: Record<string, unknown>) => void;
        signal?: AbortSignal;
      }) => Promise<unknown>;
    } = {},
  ) {
    const state = { closed: 0 };
    const gezel = {
      openai: {
        models: async () => ({ object: 'list', data: options.models ?? [] }),
        knowledge: {
          state: async () => ({}),
          update: async () => undefined,
          retrieve: async () => ({ reranked: true, passages: [] }),
        },
      },
      ensureModel: options.ensureModel ?? (async () => ({ source: 'present' })),
      close: async () => {
        state.closed += 1;
      },
    };
    return { gezel, state };
  }

  function ladder(options: {
    connectLocal: () => Promise<unknown>;
    runtime?: typeof RUNTIME | null;
    hostInProcess?: boolean;
    hostNative?: import('../main/ai/gezel-native-host.js').GezelNativeHost;
    verifyNative?: (input: Record<string, unknown>) => Promise<unknown>;
    startService?: (input: Record<string, unknown>) => Promise<unknown>;
    hosted?: ReturnType<typeof fakeHostedGezel>;
    connectOrHost?: (input: HostCall) => Promise<unknown>;
    standalone?: boolean;
    hostHome?: string;
    appleModel?: () => Promise<import('../main/ai/ai-models.js').ProviderModelEntry>;
  }) {
    const hostCalls: HostCall[] = [];
    const hosted = options.hosted ?? fakeHostedGezel();
    const connector = new GezelConnector({
      credentials: new MemoryCredentials(),
      loadSdk: async () =>
        ({
          connectLocal: options.connectLocal,
          detectGezel: async () => ({ installed: false, running: false }),
        }) as never,
      loadHostSdk: async () =>
        ({
          connectOrHost: async (input: HostCall) => {
            hostCalls.push(input);
            return options.connectOrHost ? options.connectOrHost(input) : hosted.gezel;
          },
        }) as never,
      loadService: async () =>
        ({
          startService: options.startService ?? (async () => undefined),
          reuseVerifiedElectronNativeBinaries:
            options.verifyNative ?? (async () => ({ reused: true })),
        }) as never,
      hostRuntime: async () => (options.runtime === undefined ? RUNTIME : options.runtime),
      hostInProcess: options.hostInProcess,
      hostNative: options.hostNative,
      standalone: options.standalone,
      hostHome: options.hostHome,
      appleModel: options.appleModel,
    });
    return { connector, hostCalls, hosted };
  }

  it("hosts a private Gezel when the person's is not running", async () => {
    const { connector, hostCalls } = ladder({
      connectLocal: () => Promise.reject(refusal('daemon_not_running')),
    });
    const connection = await connector.connect({ interactive: false });
    expect(connection.mode).to.equal('hosted');
    expect(connection.version).to.equal('1.1.2');
    expect(hostCalls).to.have.length(1);
    expect(hostCalls[0].adoptUserDaemon).to.equal(false);
    expect(hostCalls[0].host).to.deep.include({
      mode: 'child',
      nodePath: RUNTIME.nodePath,
      daemonEntry: RUNTIME.daemonEntry,
      // Shipped engines: a first run downloads nothing.
      nativeBinDir: RUNTIME.nativeBinDir,
    });
  });

  it('hosts in-process without requiring an external service entry', async () => {
    const { connector, hostCalls } = ladder({
      connectLocal: () => Promise.reject(refusal('daemon_not_running')),
      runtime: null,
      hostInProcess: true,
    });
    expect((await connector.detect()).canHost).to.equal(true);
    const connection = await connector.connect({ interactive: false });
    expect(connection.mode).to.equal('hosted');
    expect(hostCalls).to.have.length(1);
    expect(hostCalls[0].host).to.deep.include({
      mode: 'in-process',
      inferenceOnly: true,
    });
    expect(hostCalls[0].host).not.to.have.property('nodePath');
    expect(hostCalls[0].host).to.have.property('serviceModule');
  });

  const BUNDLED_NATIVE = {
    nativeBinDir: RUNTIME.nativeBinDir,
    distributionProfile: 'store' as const,
    allowStandaloneMacPayload: false,
    canHost: true,
  };

  it('hosts sandbox AI without standalone discovery, grants or borrowed model homes', async () => {
    const previous = process.env.GEZEL_READONLY_MODEL_HOMES;
    process.env.GEZEL_READONLY_MODEL_HOMES = '/outside/sandbox';
    try {
      const { connector, hostCalls } = ladder({
        standalone: false,
        hostHome: '/container/ai/gezel',
        runtime: null,
        hostInProcess: true,
        hostNative: BUNDLED_NATIVE,
        connectLocal: async () => {
          throw new Error('must not connect standalone');
        },
        startService: async () => {
          expect(process.env.GEZEL_READONLY_MODEL_HOMES).to.equal(undefined);
          return { stop: async () => undefined };
        },
        connectOrHost: async (input) => {
          const service = input.host?.serviceModule as {
            startService: (
              input: Record<string, unknown>,
            ) => Promise<{ stop: () => Promise<void> }>;
          };
          const running = await service.startService({});
          return { ...fakeHostedGezel().gezel, close: running.stop };
        },
      });
      expect(await connector.detect()).to.deep.equal({
        installed: false,
        running: false,
        version: null,
        canHost: true,
      });
      const connection = await connector.connect({ interactive: false });
      expect(hostCalls[0].host).to.deep.include({
        mode: 'in-process',
        home: '/container/ai/gezel',
        readOnlyModelHomes: [],
        inferenceOnly: true,
      });
      expect(process.env.GEZEL_READONLY_MODEL_HOMES).to.equal(undefined);
      await connection.close();
      expect(process.env.GEZEL_READONLY_MODEL_HOMES).to.equal('/outside/sandbox');
    } finally {
      if (previous === undefined) delete process.env.GEZEL_READONLY_MODEL_HOMES;
      else process.env.GEZEL_READONLY_MODEL_HOMES = previous;
    }
  });

  it('offers Apple system AI and blocks Python provisioning in store hosts', async () => {
    let installs = 0;
    const hosted = fakeHostedGezel({
      models: [{ id: 'llama-cpp:writer' }, { id: 'mlx:writer' }],
      ensureModel: async () => {
        installs++;
      },
    });
    const apple = {
      id: 'apple-foundation-models:apple-foundation-models',
      owned_by: 'apple-foundation-models',
      availability: 'available' as const,
    };
    const { connector } = ladder({
      standalone: false,
      hostInProcess: true,
      hostNative: BUNDLED_NATIVE,
      hosted,
      connectLocal: async () => {
        throw new Error('must not connect standalone');
      },
      appleModel: async () => apple,
    });
    const connection = await connector.connect({ interactive: false });
    expect((await connection.listModels()).map((entry) => entry.id)).to.deep.equal([
      apple.id,
      'llama-cpp:writer',
    ]);
    await connection.prepare?.(apple.id, () => undefined);
    expect(installs).to.equal(0);
    expect(
      toAiError(await rejection(connection.prepare!('mlx:writer', () => undefined))).code,
    ).to.equal('model-unavailable');
    expect(
      toAiError(
        await rejection(
          connection.installModel!('mlx:writer', new AbortController().signal, () => undefined),
        ),
      ).code,
    ).to.equal('model-unavailable');
    expect(installs).to.equal(0);
    await connection.close();
  });

  it('runs on its own memory ledger when an older installed Gezel refuses to coordinate', async () => {
    const previous = process.env.GEZEL_NATIVE_CAPACITY_AUTHORITY;
    delete process.env.GEZEL_NATIVE_CAPACITY_AUTHORITY;
    try {
      const hosted = fakeHostedGezel();
      const authorities: Array<string | undefined> = [];
      Object.assign(hosted.gezel.openai, {
        chat: async () => {
          authorities.push(process.env.GEZEL_NATIVE_CAPACITY_AUTHORITY);
          const refused = authorities.length === 1;
          return (async function* () {
            // Gezel opens every stream with an empty chunk before the provider
            // runs, so the refusal arrives second.
            yield { choices: [{ delta: { role: 'assistant' }, finish_reason: null }] };
            if (refused)
              throw Object.assign(
                new Error(
                  'The installed machine engine needs an update before isolated local engines can share memory safely.',
                ),
                { code: 'provider_error' },
              );
            yield { choices: [{ delta: { content: 'Draft' }, finish_reason: 'stop' }] };
          })();
        },
      });
      const id = 'apple-foundation-models:apple-foundation-models';
      const { connector } = ladder({
        standalone: false,
        hostInProcess: true,
        hosted,
        connectLocal: async () => {
          throw new Error('must not connect standalone');
        },
        appleModel: async () => ({
          id,
          owned_by: 'apple-foundation-models',
          availability: 'available',
        }),
      });
      const connection = await connector.connect({ interactive: false });
      const stream = await connection.streamChat(
        { model: id, messages: [{ role: 'user' as const, content: 'Hi' }] },
        new AbortController().signal,
      );
      const chunks: ProviderChatChunk[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(chunks.map((chunk) => chunk.text).join('')).to.equal('Draft');
      // The person never sees the refusal; the retry runs on the local ledger.
      expect(authorities).to.deep.equal([undefined, 'local']);
      await connection.close();
    } finally {
      if (previous === undefined) delete process.env.GEZEL_NATIVE_CAPACITY_AUTHORITY;
      else process.env.GEZEL_NATIVE_CAPACITY_AUTHORITY = previous;
    }
  });

  it('routes Apple inference through Gezel and refuses an unavailable system model', async () => {
    const hosted = fakeHostedGezel();
    let ready = true;
    const requests: Record<string, unknown>[] = [];
    Object.assign(hosted.gezel.openai, {
      chat: async (request: Record<string, unknown>) => {
        requests.push(request);
        return (async function* () {
          yield { choices: [{ delta: { content: 'Apple reply' }, finish_reason: 'stop' }] };
        })();
      },
    });
    const id = 'apple-foundation-models:apple-foundation-models';
    const { connector } = ladder({
      standalone: false,
      hostInProcess: true,
      hosted,
      connectLocal: async () => {
        throw new Error('must not connect standalone');
      },
      appleModel: async () => ({
        id,
        owned_by: 'apple-foundation-models',
        availability: ready ? 'available' : 'unavailable',
        unavailable_reason: 'Enable Apple Intelligence.',
      }),
    });
    const connection = await connector.connect({ interactive: false });
    const request = { model: id, messages: [{ role: 'user' as const, content: 'Hi' }] };
    const stream = await connection.streamChat(request, new AbortController().signal);
    const chunks: ProviderChatChunk[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks[0].text).to.equal('Apple reply');
    expect(requests[0].model).to.equal(id);
    ready = false;
    expect(
      toAiError(await rejection(connection.streamChat(request, new AbortController().signal))).code,
    ).to.equal('model-unavailable');
    expect(requests).to.have.length(1);
    await connection.close();
  });

  it('verifies bundled engines before passing their directory and store policy to the in-process SDK', async () => {
    const verification: Record<string, unknown>[] = [];
    const previous = process.env.GEZEL_NATIVE_BIN_DIR;
    const { connector, hostCalls } = ladder({
      connectLocal: () => Promise.reject(refusal('daemon_not_running')),
      runtime: null,
      hostInProcess: true,
      hostNative: BUNDLED_NATIVE,
      verifyNative: async (input) => {
        verification.push(input);
        process.env.GEZEL_NATIVE_BIN_DIR = RUNTIME.nativeBinDir;
        return { reused: true };
      },
    });
    await connector.connect({ interactive: false });
    expect(verification).to.deep.equal([
      {
        candidates: [RUNTIME.nativeBinDir],
        allowStandaloneMacPayload: false,
      },
    ]);
    expect(hostCalls[0].host).to.deep.include({
      mode: 'in-process',
      nativeBinDir: RUNTIME.nativeBinDir,
      distributionProfile: 'store',
    });
    expect(process.env.GEZEL_NATIVE_BIN_DIR).to.equal(previous);
  });

  it('rejects invalid bundled engines without starting the SDK or falling back to downloads', async () => {
    const previous = process.env.GEZEL_NATIVE_BIN_DIR;
    const { connector, hostCalls } = ladder({
      connectLocal: () => Promise.reject(refusal('daemon_not_running')),
      runtime: null,
      hostInProcess: true,
      hostNative: BUNDLED_NATIVE,
      verifyNative: async () => {
        process.env.GEZEL_NATIVE_BIN_DIR = 'rejected';
        return { reused: false, reason: 'sha256 mismatch' };
      },
    });
    const error = toAiError(await rejection(connector.connect({ interactive: false })));
    expect(error.code).to.equal('runtime-missing');
    expect(error.detail).to.contain('sha256 mismatch');
    expect(hostCalls).to.have.length(0);
    expect(process.env.GEZEL_NATIVE_BIN_DIR).to.equal(previous);
  });

  it('hands newer SDK verification back to the same pinned payload policy', async () => {
    const verification: Record<string, unknown>[] = [];
    const { connector, hostCalls } = ladder({
      connectLocal: () => Promise.reject(refusal('daemon_not_running')),
      runtime: null,
      hostInProcess: true,
      hostNative: BUNDLED_NATIVE,
      verifyNative: async (input) => {
        verification.push(input);
        return { reused: true, reason: 'verified' };
      },
    });
    const connection = await connector.connect({ interactive: false });
    const service = hostCalls[0].host?.serviceModule as {
      verifyNativeBinaries(input: { candidates: string[] }): Promise<{ reused: boolean }>;
    };
    expect(
      (await service.verifyNativeBinaries({ candidates: [RUNTIME.nativeBinDir] })).reused,
    ).to.equal(true);
    expect(verification).to.have.length(2);
    expect(verification[1]).to.deep.equal(verification[0]);
    expect(
      (await service.verifyNativeBinaries({ candidates: ['/outside/payload'] })).reused,
    ).to.equal(false);
    expect(verification).to.have.length(2);
    await connection.close();
  });

  it('never verifies or hosts bundled engines when the standalone Gezel connects', async () => {
    const hosted = fakeHostedGezel();
    let verified = false;
    const { connector, hostCalls } = ladder({
      connectLocal: async () => ({
        app: hosted.gezel,
        authorization: { daemon: { mode: 'adopted' } },
      }),
      hostInProcess: true,
      hostNative: BUNDLED_NATIVE,
      verifyNative: async () => {
        verified = true;
        return { reused: true };
      },
    });
    const connection = await connector.connect({ interactive: false });
    expect(connection.mode).to.equal('installed');
    expect(verified).to.equal(false);
    expect(hostCalls).to.have.length(0);
  });

  it('removes ambient executable overrides for the lifetime of a packaged service', async () => {
    const previous = process.env.GEZEL_LLAMA_SERVER_BIN;
    process.env.GEZEL_LLAMA_SERVER_BIN = '/unverified/llama-server';
    try {
      const { connector } = ladder({
        connectLocal: () => Promise.reject(refusal('daemon_not_running')),
        runtime: null,
        hostInProcess: true,
        hostNative: BUNDLED_NATIVE,
        startService: async () => {
          expect(process.env.GEZEL_LLAMA_SERVER_BIN).to.equal(undefined);
          process.env.GEZEL_LLAMA_SERVER_BIN = '/verified/llama-server';
          return { stop: async () => undefined };
        },
        connectOrHost: async (input) => {
          const service = input.host?.serviceModule as {
            startService: (
              input: Record<string, unknown>,
            ) => Promise<{ stop: () => Promise<void> }>;
          };
          const running = await service.startService({});
          return { ...fakeHostedGezel().gezel, close: running.stop };
        },
      });
      const connection = await connector.connect({ interactive: false });
      expect(process.env.GEZEL_LLAMA_SERVER_BIN).to.equal('/verified/llama-server');
      await connection.close();
      expect(process.env.GEZEL_LLAMA_SERVER_BIN).to.equal('/unverified/llama-server');
    } finally {
      if (previous === undefined) delete process.env.GEZEL_LLAMA_SERVER_BIN;
      else process.env.GEZEL_LLAMA_SERVER_BIN = previous;
    }
  });

  it('hosts when the running Gezel will not connect DocBlocks', async () => {
    // The person switched AI on inside DocBlocks; a refusal from Gezel's
    // connected-app flow falls back rather than leaving AI off.
    for (const code of [
      'user_denied',
      'approval_timeout',
      'grant_expired',
      'verification_code_handler_required',
      'openai_endpoints_disabled',
    ]) {
      const { connector, hostCalls } = ladder({
        connectLocal: () => Promise.reject(refusal(code)),
      });
      const connection = await connector.connect({
        interactive: true,
        onVerificationCode: () => undefined,
      });
      expect(connection.mode, code).to.equal('hosted');
      expect(hostCalls, code).to.have.length(1);
    }
  });

  it('surfaces a running Gezel that fails for another reason', async () => {
    const { connector, hostCalls } = ladder({
      connectLocal: () => Promise.reject(refusal('server_error', 500)),
    });
    const error = await rejection(connector.connect({ interactive: false }));
    expect(toAiError(error).code).to.equal('unknown');
    expect(hostCalls).to.have.length(0);
  });

  it('does not pretend to host without a runtime', async () => {
    const { connector, hostCalls } = ladder({
      connectLocal: () => Promise.reject(refusal('daemon_not_running')),
      runtime: null,
    });
    const error = await rejection(connector.connect({ interactive: false }));
    expect(toAiError(error).code).to.equal('provider-unavailable');
    expect(hostCalls).to.have.length(0);
    expect((await connector.detect()).canHost).to.equal(false);
  });

  it('offers only the on-device models a hosted daemon can run', async () => {
    const hosted = fakeHostedGezel({
      models: [
        { id: 'gezel:meester', owned_by: 'gezel' },
        { id: 'anthropic-cli:opus', owned_by: 'anthropic-cli' },
        { id: 'llama-cpp:qwen3.8-27b-q4', owned_by: 'llama-cpp' },
        { id: 'mlx:gemma4-e4b', owned_by: 'mlx' },
        { id: 'ollama:llama3.1:8b', owned_by: 'ollama' },
      ],
    });
    const { connector } = ladder({
      connectLocal: () => Promise.reject(refusal('daemon_not_running')),
      hosted,
    });
    const connection = await connector.connect({ interactive: false });
    expect((await connection.listModels()).map((model) => model.id)).to.deep.equal([
      'llama-cpp:qwen3.8-27b-q4',
      'mlx:gemma4-e4b',
    ]);
    await connection.close();
    expect(hosted.state.closed).to.equal(1);
  });

  it('prepares an engine but never downloads model weights', async () => {
    let allowWeightDownload: boolean | undefined;
    const hosted = fakeHostedGezel({
      ensureModel: async (options) => {
        allowWeightDownload = options.allowWeightDownload;
        options.onEvent?.({
          phase: 'engine',
          engine: 'llama-server',
          message: 'downloading',
          percent: 50,
        });
        throw Object.assign(new Error('weights require a gesture'), {
          code: 'model_download_required',
        });
      },
    });
    const { connector } = ladder({
      connectLocal: () => Promise.reject(refusal('daemon_not_running')),
      hosted,
    });
    const connection = await connector.connect({ interactive: false });
    const progress: unknown[] = [];
    const error = await rejection(
      connection.prepare?.('llama-cpp:qwen3.8-27b-q4', (event) => progress.push(event)) ??
        Promise.reject(new Error('hosted connections prepare models')),
    );
    expect(toAiError(error).code).to.equal('model-unavailable');
    expect(allowWeightDownload).to.equal(false);
    expect(progress).to.deep.equal([{ phase: 'engine', message: 'downloading', percent: 50 }]);
  });

  it('downloads hosted model weights after an explicit install request', async () => {
    const hosted = fakeHostedGezel({
      ensureModel: async ({ onEvent }) => {
        onEvent?.({
          phase: 'weights',
          message: 'downloading weights',
          bytesWritten: 50,
          totalBytes: 100,
        });
        onEvent?.({ phase: 'ready', message: 'ready' });
        return { source: 'downloaded' };
      },
    });
    const { connector } = ladder({
      connectLocal: () => Promise.reject(refusal('daemon_not_running')),
      hosted,
    });
    const connection = await connector.connect({ interactive: false });
    const progress: unknown[] = [];
    await connection.installModel?.(
      'llama-cpp:qwen3.8-27b-q4',
      new AbortController().signal,
      (event) => progress.push(event),
    );
    expect(progress).to.deep.equal([
      { phase: 'weights', message: 'downloading weights', percent: 50 },
      { phase: 'ready', message: 'Model is ready.', percent: 100 },
    ]);
  });

  it('reports a daemon that will not start as a missing runtime, with the reason', async () => {
    const { connector } = ladder({
      connectLocal: () => Promise.reject(refusal('daemon_not_running')),
      connectOrHost: () => Promise.reject(refusal('node_binary_required')),
    });
    const error = toAiError(await rejection(connector.connect({ interactive: false })));
    expect(error.code).to.equal('runtime-missing');
    expect(error.message).to.equal('DocBlocks could not start its built-in Gezel.');
    expect(error.detail).to.equal('gezel said node_binary_required');
  });
});
