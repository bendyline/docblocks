import { expect } from 'chai';
import type { ProofingProvider } from '@bendyline/squisq-editor-react';
import {
  createProofingEngineSource,
  type ProofingEngineSourceEnvironment,
} from '../webview/src/proofingEngineSource.js';
import { createDeferredProofingProvider } from '../webview/src/deferredProofingProvider.js';

const WASM_URL =
  'https://file+.vscode-resource.vscode-cdn.net/ext/dist/webview/harper/harper_wasm_bg.wasm';

interface FakeEnvironment extends ProofingEngineSourceEnvironment {
  readonly fetched: string[];
  readonly created: Blob[];
  readonly revoked: string[];
  respond(response: () => Response | Promise<Response>): void;
}

function fakeEnvironment(): FakeEnvironment {
  let next: () => Response | Promise<Response> = () =>
    new Response(new Uint8Array([0, 97, 115, 109]), {
      status: 200,
      headers: { 'Content-Type': 'application/wasm' },
    });
  const fetched: string[] = [];
  const created: Blob[] = [];
  const revoked: string[] = [];
  return {
    fetched,
    created,
    revoked,
    respond(response) {
      next = response;
    },
    async fetch(url) {
      fetched.push(url);
      return next();
    },
    createObjectURL(blob) {
      created.push(blob);
      return `blob:vscode-webview://stub/${created.length}`;
    },
    revokeObjectURL(url) {
      revoked.push(url);
    },
  };
}

/** Squisq's provider surface, recording what reached it. */
function recordingProvider(calls: string[]): ProofingProvider {
  return {
    hasAppDictionary: true,
    async setup() {
      calls.push('setup');
    },
    async lint(text) {
      calls.push(`lint:${text}`);
      return [];
    },
    async ignoreFinding(findingId) {
      calls.push(`ignoreFinding:${findingId}`);
    },
    async addWord(word) {
      calls.push(`addWord:${word}`);
    },
    async addWords(words) {
      calls.push(`addWords:${words.join(',')}`);
    },
    async exportIgnored() {
      calls.push('exportIgnored');
      return '[]';
    },
    async importIgnored(json) {
      calls.push(`importIgnored:${json}`);
    },
    async clearIgnored() {
      calls.push('clearIgnored');
    },
    async setDialect(dialect) {
      calls.push(`setDialect:${dialect}`);
    },
    dispose() {
      calls.push('dispose');
    },
  };
}

describe('VS Code proofing engine source', () => {
  it('downloads nothing until the engine is first needed', () => {
    const environment = fakeEnvironment();
    createProofingEngineSource(WASM_URL, environment);
    expect(environment.fetched).to.deep.equal([]);
  });

  it('fetches the packaged binary from the page and republishes it as a wasm blob', async () => {
    const environment = fakeEnvironment();
    const source = createProofingEngineSource(WASM_URL, environment);

    const url = await source.resolve();

    expect(url).to.match(/^blob:/u);
    expect(environment.fetched).to.deep.equal([WASM_URL]);
    expect(environment.created).to.have.length(1);
    expect(environment.created[0]?.type).to.equal('application/wasm');
    expect(environment.created[0]?.size).to.equal(4);
  });

  it('types the blob for streaming compilation even when the response does not', async () => {
    const environment = fakeEnvironment();
    environment.respond(
      () =>
        new Response(new Uint8Array([0, 97, 115, 109]), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
    );
    const source = createProofingEngineSource(WASM_URL, environment);

    await source.resolve();

    expect(environment.created[0]?.type).to.equal('application/wasm');
  });

  it('shares one download between concurrent callers', async () => {
    const environment = fakeEnvironment();
    const source = createProofingEngineSource(WASM_URL, environment);

    const [first, second] = await Promise.all([source.resolve(), source.resolve()]);

    expect(first).to.equal(second);
    expect(environment.fetched).to.have.length(1);
  });

  it('rejects an unsuccessful response and retries on the next call', async () => {
    const environment = fakeEnvironment();
    environment.respond(() => new Response('Request Timeout', { status: 408 }));
    const source = createProofingEngineSource(WASM_URL, environment);

    let failure: unknown;
    try {
      await source.resolve();
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    expect((failure as Error).message).to.include('408');
    expect(environment.created).to.have.length(0);

    environment.respond(
      () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { 'Content-Type': 'application/wasm' },
        }),
    );
    expect(await source.resolve()).to.match(/^blob:/u);
    expect(environment.fetched).to.have.length(2);
  });

  it('revokes the blob on dispose and refuses later requests', async () => {
    const environment = fakeEnvironment();
    const source = createProofingEngineSource(WASM_URL, environment);
    const url = await source.resolve();

    source.dispose();
    source.dispose();

    expect(environment.revoked).to.deep.equal([url]);
    let failure: unknown;
    try {
      await source.resolve();
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
  });

  it('does not publish a blob for a download that finishes after dispose', async () => {
    const environment = fakeEnvironment();
    let release: () => void = () => undefined;
    environment.respond(
      () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              new Response(new Uint8Array([1]), {
                status: 200,
                headers: { 'Content-Type': 'application/wasm' },
              }),
            );
        }),
    );
    const source = createProofingEngineSource(WASM_URL, environment);
    const pending = source.resolve().then(
      () => 'resolved',
      () => 'rejected',
    );
    await Promise.resolve();

    source.dispose();
    release();

    expect(await pending).to.equal('rejected');
    expect(environment.created).to.have.length(0);
  });
});

describe('deferred VS Code proofing provider', () => {
  it('builds nothing at construction and reports the dictionary capability', () => {
    let builds = 0;
    const provider = createDeferredProofingProvider({
      hasAppDictionary: true,
      create: async () => {
        builds += 1;
        return recordingProvider([]);
      },
    });

    expect(builds).to.equal(0);
    expect(provider.hasAppDictionary).to.equal(true);
  });

  it('builds once and forwards every operation to the built provider', async () => {
    const calls: string[] = [];
    let builds = 0;
    const provider = createDeferredProofingProvider({
      hasAppDictionary: true,
      create: async () => {
        builds += 1;
        return recordingProvider(calls);
      },
    });

    await provider.setup();
    expect(await provider.lint('teh text')).to.deep.equal([]);
    await provider.ignoreFinding('1:0');
    await provider.addWord('DocBlocks');
    await provider.addWords(['Squisq']);
    expect(await provider.exportIgnored()).to.equal('[]');
    await provider.importIgnored('{}');
    await provider.clearIgnored();
    await provider.setDialect('British');

    expect(builds).to.equal(1);
    expect(calls).to.deep.equal([
      'setup',
      'lint:teh text',
      'ignoreFinding:1:0',
      'addWord:DocBlocks',
      'addWords:Squisq',
      'exportIgnored',
      'importIgnored:{}',
      'clearIgnored',
      'setDialect:British',
    ]);
  });

  it('does not build the engine to add an empty word list', async () => {
    let builds = 0;
    const provider = createDeferredProofingProvider({
      hasAppDictionary: true,
      create: async () => {
        builds += 1;
        return recordingProvider([]);
      },
    });

    await provider.addWords([]);

    expect(builds).to.equal(0);
  });

  it('retries a failed build on the next call', async () => {
    let builds = 0;
    const provider = createDeferredProofingProvider({
      hasAppDictionary: true,
      create: async () => {
        builds += 1;
        if (builds === 1) throw new Error('Could not load the proofing engine (HTTP 408)');
        return recordingProvider([]);
      },
    });

    let failure: unknown;
    try {
      await provider.setup();
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).to.include('408');

    await provider.setup();
    expect(builds).to.equal(2);
  });

  it('disposes the built provider and its resources exactly once', async () => {
    const calls: string[] = [];
    let released = 0;
    const provider = createDeferredProofingProvider({
      hasAppDictionary: true,
      create: async () => recordingProvider(calls),
      onDispose: () => {
        released += 1;
      },
    });
    await provider.setup();

    provider.dispose();
    provider.dispose();

    expect(calls.filter((call) => call === 'dispose')).to.have.length(1);
    expect(released).to.equal(1);
    let failure: unknown;
    try {
      await provider.lint('text');
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
  });

  it('disposes a provider whose build finishes after dispose', async () => {
    const calls: string[] = [];
    let finishBuild: (provider: ProofingProvider) => void = () => undefined;
    const provider = createDeferredProofingProvider({
      hasAppDictionary: true,
      create: () =>
        new Promise<ProofingProvider>((resolve) => {
          finishBuild = resolve;
        }),
    });
    const setup = provider.setup().catch(() => undefined);

    provider.dispose();
    finishBuild(recordingProvider(calls));
    await setup;
    await Promise.resolve();

    expect(calls).to.include('dispose');
    expect(calls.filter((call) => call === 'dispose')).to.have.length(1);
  });
});
