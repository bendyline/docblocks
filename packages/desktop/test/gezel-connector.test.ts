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

  it('an interactive connect asks for an inference-only grant with a typed code', async () => {
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
      scopes: ['openai'],
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
      temperature: 0.2,
      max_tokens: 64,
    });
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
        onEvent?: (event: Record<string, unknown>) => void;
        signal?: AbortSignal;
      }) => Promise<unknown>;
    } = {},
  ) {
    const state = { closed: 0 };
    const gezel = {
      openai: {
        models: async () => ({ object: 'list', data: options.models ?? [] }),
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
    hosted?: ReturnType<typeof fakeHostedGezel>;
    connectOrHost?: (input: HostCall) => Promise<unknown>;
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
      hostRuntime: async () => (options.runtime === undefined ? RUNTIME : options.runtime),
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
    const hosted = fakeHostedGezel({
      ensureModel: ({ onEvent, signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
          onEvent?.({
            phase: 'engine',
            engine: 'llama-server',
            message: 'downloading',
            percent: 50,
          });
          onEvent?.({
            phase: 'weights',
            message: 'downloading',
            bytesWritten: 1024,
            totalBytes: 9e9,
          });
        }),
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
    expect(progress).to.deep.equal([{ phase: 'engine', message: 'downloading', percent: 50 }]);
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
