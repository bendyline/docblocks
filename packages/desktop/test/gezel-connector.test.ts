/**
 * The real Gezel app SDK against a fake daemon.
 *
 * These pin the SDK behaviour DocBlocks' safety rests on — above all that a
 * silent reconnect can never register a new grant, which is what would raise
 * a consent prompt in Gezel with no user gesture behind it. An SDK upgrade
 * that changed that ordering must fail here, not in someone's Gezel window.
 */

import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HostServiceModule } from '@bendyline/gezel-app-sdk/host';

import { toAiError } from '../main/ai/ai-errors.js';
import {
  GezelConnector,
  type AiCredentialStore,
  type GezelConnectorOptions,
} from '../main/ai/gezel-connector.js';
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
  chatProgress: unknown[] = [];
  additionalModels: unknown[] = [];
  modelInstalled = false;
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
          ...this.additionalModels,
          ...(this.modelInstalled
            ? [
                {
                  id: 'llama-cpp:small-writer',
                  object: 'model',
                  created: 1,
                  owned_by: 'llama-cpp',
                  availability: 'available',
                },
              ]
            : []),
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
      this.modelInstalled = true;
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
        ...this.chatProgress.map((gezel_progress) => ({
          ...chunk(undefined, null),
          choices: [],
          gezel_progress,
        })),
        {
          ...chunk(undefined, null),
          choices: [
            { index: 0, delta: { reasoning_content: 'Private planning.' }, finish_reason: null },
          ],
        },
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
    const [model] = await connection.listModels();
    expect(model).to.include({
      id: 'gezel:writer',
      availability: 'available',
      locality: 'unknown',
    });
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
      stream_options: { include_usage: true, include_progress: true },
      reasoning_effort: 'none',
      temperature: 0.2,
      max_tokens: 64,
    });
  });

  for (const purpose of ['write', 'chat', 'review', 'illustrate'] as const) {
    it(`uses the expected reasoning policy for ${purpose} through the real SDK`, async () => {
      const daemon = new FakeDaemon();
      daemon.validToken = 'kept-token';
      const connection = await connectorFor(daemon, new MemoryCredentials('kept-token')).connect({
        interactive: false,
      });
      const stream = await connection.streamChat(
        {
          model: 'gezel:writer',
          messages: [{ role: 'user', content: 'Rewrite this.' }],
          purpose,
          maxTokens: 8192,
          temperature: 0.35,
        },
        new AbortController().signal,
      );
      const chunks: ProviderChatChunk[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(chunks.map((chunk) => chunk.text).join('')).to.equal('Hello');
      const request = daemon.requests.find((entry) => entry.path === '/v1/chat/completions');
      expect(request?.body).to.deep.equal({
        model: 'gezel:writer',
        messages: [{ role: 'user', content: 'Rewrite this.' }],
        stream: true,
        stream_options: { include_usage: true, include_progress: true },
        ...(purpose === 'write' ? {} : { reasoning_effort: 'none' }),
        temperature: 0.35,
        max_tokens: 8192,
      });
    });
  }

  for (const model of ['mlx:writer', 'llama-cpp:writer', 'ollama:writer', 'ds4:writer']) {
    it(`uses model capacity instead of a fixed writing cap for ${model}`, async () => {
      const daemon = new FakeDaemon();
      daemon.validToken = 'kept-token';
      const connection = await connectorFor(daemon, new MemoryCredentials('kept-token')).connect({
        interactive: false,
      });
      const stream = await connection.streamChat(
        {
          model,
          purpose: 'write',
          contextWindow: 262_144,
          messages: [{ role: 'user', content: 'Rewrite the complete document.' }],
        },
        new AbortController().signal,
      );
      for await (const chunk of stream) expect(chunk).to.have.property('text');
      const request = daemon.requests.find((entry) => entry.path === '/v1/chat/completions');
      expect(request?.body).to.have.property('max_tokens', 262_144);
    });
  }

  it('leaves unknown and remote output capacity to the provider without a fixed app cap', async () => {
    const daemon = new FakeDaemon();
    daemon.validToken = 'kept-token';
    const connection = await connectorFor(daemon, new MemoryCredentials('kept-token')).connect({
      interactive: false,
    });
    for (const request of [
      { model: 'mlx:writer', contextWindow: null },
      { model: 'openai:writer', contextWindow: 262_144 },
    ]) {
      const stream = await connection.streamChat(
        { ...request, purpose: 'write', messages: [{ role: 'user', content: 'Write.' }] },
        new AbortController().signal,
      );
      for await (const chunk of stream) expect(chunk).to.have.property('text');
    }
    for (const request of daemon.requests.filter(
      (entry) => entry.path === '/v1/chat/completions',
    )) {
      expect(request.body).not.to.have.property('max_tokens');
    }
  });

  it('receives validated progress through the installed SDK without changing completion text', async () => {
    const daemon = new FakeDaemon();
    daemon.validToken = 'kept-token';
    const progress = { phase: 'prefill', percent: 42, outputTokens: null, tokensPerSecond: null };
    daemon.chatProgress = [
      progress,
      { ...progress, percent: 101 },
      { ...progress, detail: 'private' },
    ];
    const connection = await connectorFor(daemon, new MemoryCredentials('kept-token')).connect({
      interactive: false,
    });
    const stream = await connection.streamChat(
      { model: 'gezel:writer', messages: [{ role: 'user', content: 'Hi' }], purpose: 'write' },
      new AbortController().signal,
    );
    const chunks: ProviderChatChunk[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks.flatMap((chunk) => (chunk.progress ? [chunk.progress] : []))).to.deep.equal([
      progress,
    ]);
    expect(chunks.map((chunk) => chunk.text).join('')).to.equal('Hello');
    expect(chunks.at(-1)?.finishReason).to.equal('stop');
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
      { phase: 'downloading', message: 'Downloading model', percent: 25 },
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

describe('Gezel connector with the real embedding SDK', () => {
  let root: string;
  const cleanup: Array<() => Promise<void>> = [];
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-embedding-'));
  });
  afterEach(async () => {
    try {
      for (const close of cleanup.splice(0)) await close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  function hosted(options: Partial<GezelConnectorOptions> = {}) {
    const daemon = new FakeDaemon();
    daemon.validToken = 'private-token';
    const starts: unknown[] = [];
    const verifications: unknown[] = [];
    let stops = 0;
    const service: HostServiceModule = {
      async startService(input) {
        starts.push(input);
        return {
          port: 49998,
          clientToken: 'private-token',
          cert: null,
          profile: 'embedded-inference',
          fetch: daemon.fetch,
          stop: async () => {
            stops++;
          },
        };
      },
      async verifyNativeBinaries(input) {
        verifications.push(input);
        return { reused: true, reason: 'fixture', nativeBinDir: input.candidates[0] };
      },
    };
    const connector = new GezelConnector({
      credentials: new MemoryCredentials(),
      home: root,
      hostInProcess: true,
      loadService: async () => service,
      ...options,
    });
    async function connect() {
      const connection = await connector.connect({ interactive: false });
      cleanup.push(() => connection.close());
      return connection;
    }
    return { connector, connect, service, starts, verifications, daemon, stops: () => stops };
  }

  it('silently hosts an inference-only service with direct transport when Gezel is absent', async () => {
    const fixture = hosted();
    const connection = await fixture.connect();
    expect(connection.mode).to.equal('hosted');
    expect(fixture.starts).to.deep.equal([
      {
        home: path.join(root, 'apps', 'docblocks'),
        role: 'user',
        embeddedInferenceOnly: true,
        port: 0,
        preferCanonicalPort: false,
      },
    ]);
    expect(fixture.daemon.paths()).not.to.include('POST /v1/apps/register');
    await connection.close();
    await connection.close();
    expect(fixture.stops()).to.equal(1);
  });

  it('keeps packaged hosting inside its home and lets the SDK scrub and restore engine overrides', async () => {
    const keys = ['GEZEL_READONLY_MODEL_HOMES', 'GEZEL_LLAMA_SERVER_BIN', 'GGML_BACKEND_PATH'];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) process.env[key] = '/outside/sandbox';
    try {
      const fixture = hosted({
        standalone: false,
        hostHome: path.join(root, 'private'),
        hostNative: {
          nativeBinDir: path.join(root, 'native'),
          distributionProfile: 'store',
          allowStandaloneMacPayload: false,
          canHost: true,
        },
      });
      expect(await fixture.connector.detect()).to.deep.equal({
        installed: false,
        running: false,
        version: null,
        canHost: true,
      });
      const connection = await fixture.connect();
      for (const key of keys) expect(process.env[key], key).to.equal(undefined);
      expect(fixture.verifications).to.deep.equal([
        { candidates: [path.join(root, 'native')], allowStandaloneMacPayload: false },
      ]);
      expect(fixture.starts[0]).to.include({ home: path.join(root, 'private') });
      await connection.close();
      for (const key of keys) expect(process.env[key], key).to.equal('/outside/sandbox');
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('rejects an invalid native payload before starting the service', async () => {
    const fixture = hosted({
      hostNative: {
        nativeBinDir: path.join(root, 'native'),
        distributionProfile: 'store',
        allowStandaloneMacPayload: false,
        canHost: true,
      },
    });
    fixture.service.verifyNativeBinaries = async () => ({ reused: false, reason: 'bad signature' });
    const error = toAiError(await rejection(fixture.connect()));
    expect(error.code).to.equal('runtime-missing');
    expect(error.detail).to.contain('bad signature');
    expect(fixture.starts).to.deep.equal([]);
  });

  it('does not verify or load bundled engines when a stored standalone grant works', async () => {
    const daemon = new FakeDaemon();
    daemon.validToken = 'kept-token';
    const connection = await new GezelConnector({
      credentials: new MemoryCredentials('kept-token'),
      endpoint: { baseUrl: BASE_URL, fetch: daemon.fetch },
      hostInProcess: true,
      hostNative: {
        nativeBinDir: '/unused',
        distributionProfile: 'store',
        allowStandaloneMacPayload: false,
        canHost: true,
      },
      loadService: async () => {
        throw new Error('must not load hosted service');
      },
    }).connect({ interactive: false });
    cleanup.push(() => connection.close());
    expect(connection.mode).to.equal('installed');
  });

  it('uses SDK inventory for system model readiness and filters unsupported hosted engines', async () => {
    const fixture = hosted();
    fixture.daemon.additionalModels = [
      {
        id: 'apple-foundation-models:apple-foundation-models',
        object: 'model',
        created: 0,
        owned_by: 'apple-foundation-models',
        availability: 'unavailable',
        unavailable_reason: 'Enable Apple Intelligence.',
        locality: 'on-device',
        preparation: 'system-settings',
      },
      {
        id: 'llama-cpp:writer',
        object: 'model',
        created: 0,
        owned_by: 'llama-cpp',
        availability: 'available',
        locality: 'on-device',
      },
      {
        id: 'copilot:writer',
        object: 'model',
        created: 0,
        owned_by: 'copilot',
        availability: 'available',
        locality: 'network',
      },
    ];
    const connection = await fixture.connect();
    expect((await connection.listModels()).map((entry) => entry.id)).to.deep.equal([
      'apple-foundation-models:apple-foundation-models',
      'llama-cpp:writer',
    ]);
    const error = toAiError(
      await rejection(
        connection.streamChat(
          {
            model: 'apple-foundation-models:apple-foundation-models',
            messages: [{ role: 'user', content: 'Hello' }],
          },
          new AbortController().signal,
        ),
      ),
    );
    expect(error.code).to.equal('model-unavailable');
    expect(error.message).to.equal('Enable Apple Intelligence.');
    expect(fixture.daemon.paths()).not.to.include('POST /v1/chat/completions');
  });

  it('requires the embedding SDK instead of quietly running the legacy integration', async () => {
    const connector = new GezelConnector({
      credentials: new MemoryCredentials(),
      loadHostSdk: async () => ({}) as typeof import('@bendyline/gezel-app-sdk/host'),
    });
    expect(toAiError(await rejection(connector.connect({ interactive: false }))).code).to.equal(
      'runtime-missing',
    );
  });
});
