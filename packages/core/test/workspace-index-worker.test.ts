import { expect } from 'chai';
import { MemoryFileSystemProviderV2 } from '../src/filesystem/memory-provider-v2.js';
import { parseWorkspacePath } from '../src/filesystem/workspace-path.js';
import {
  createMemoryEngine,
  createWorkerEngine,
  createWorkspaceIndex,
  serveWorkspaceIndexEngine,
  type EngineHost,
  type EnginePort,
  type ServedEngine,
  type WorkspaceIndex,
  type WorkspaceIndexEngine,
  withMemoryFallback,
} from '../src/workspace-index/index.js';

const encode = (text: string) => new TextEncoder().encode(text);

const openChannels: MessagePort[] = [];

/** A real MessageChannel standing in for the page ⇄ worker boundary. */
function channel(): {
  page: EnginePort;
  worker: EngineHost;
  close: () => void;
  crash: () => void;
} {
  const { port1, port2 } = new MessageChannel();
  port1.start();
  port2.start();
  openChannels.push(port1, port2);
  // A MessagePort never reports `error`; a dying Worker does. Tests raise it here.
  const errorListeners = new Set<(event: Event) => void>();
  const page: EnginePort = {
    postMessage: (message, transfer) => port1.postMessage(message, transfer ?? []),
    addEventListener: (type, listener) => {
      if (type === 'error') errorListeners.add(listener);
      else port1.addEventListener('message', listener as (event: MessageEvent) => void);
    },
    removeEventListener: (type, listener) => {
      if (type === 'error') errorListeners.delete(listener);
      else port1.removeEventListener('message', listener as (event: MessageEvent) => void);
    },
  };
  return {
    page,
    worker: port2 as unknown as EngineHost,
    close: () => {
      port1.close();
      port2.close();
    },
    crash: () => {
      for (const listener of errorListeners) listener({ type: 'error' } as Event);
    },
  };
}

async function ready(index: WorkspaceIndex): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const status = index.getStatus();
    if (status.phase === 'ready' && status.pendingCount === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('index never settled');
}

const served = (engine: WorkspaceIndexEngine = createMemoryEngine()): ServedEngine => ({
  engine: Object.assign(engine, {
    find: (query: string) => [
      {
        path: 'a.md',
        title: 'A',
        headingPath: [],
        lineStart: 1,
        lineEnd: 1,
        snippet: query,
        ranges: [],
        score: 1,
      },
    ],
  }),
  opened: { persistence: 'memory', reset: null, ranks: true },
});

describe('workspace index engine in a worker', () => {
  afterEach(() => {
    for (const port of openChannels.splice(0)) port.close();
  });

  it('runs analysis and search behind the channel', async () => {
    const { page, worker, close } = channel();
    let openedWith: unknown = null;
    serveWorkspaceIndexEngine(worker, async (request) => {
      openedWith = request;
      return served();
    });
    const provider = new MemoryFileSystemProviderV2('worker', 'Worker');
    await provider.writeFile(parseWorkspacePath('a.md'), encode('# Alpha\n\nheron\n'));
    await provider.writeFile(parseWorkspacePath('notes/b.md'), encode('# Beta\n'), {
      createParents: true,
    });
    const engine = createWorkerEngine(page, { workspaceKey: 'w1', persist: false });
    const index = createWorkspaceIndex({
      workspaceId: 'w1',
      source: provider,
      engine,
      yieldControl: () => Promise.resolve(),
      changeCoalesceMs: 0,
    });
    index.start();
    await ready(index);

    expect(await engine.opened).to.deep.equal({ persistence: 'memory', reset: null, ranks: true });
    expect(index.getStatus()).to.include({ persistence: 'memory', ranked: true });
    expect(openedWith).to.deep.equal({ workspaceKey: 'w1', persist: false });
    expect(index.getDocument('notes/b.md')?.title).to.equal('Beta');
    const result = await index.search({ text: 'heron' });
    expect(result.documents.map((document) => document.path)).to.deep.equal(['a.md']);
    expect((await engine.find('heron'))[0]?.snippet).to.equal('heron');
    index.dispose();
    close();
  });

  it('fails every request when the store cannot open', async () => {
    const { page, worker, close } = channel();
    serveWorkspaceIndexEngine(worker, () => Promise.reject(new Error('No storage here.')));
    const engine = createWorkerEngine(page, { workspaceKey: 'w2', persist: true });
    const opened = await engine.opened.catch((error: unknown) => error);
    expect((opened as Error).message).to.equal('No storage here.');
    const restore = await engine.restore().catch((error: unknown) => error);
    expect((restore as Error).message).to.equal('No storage here.');
    engine.dispose();
    close();
  });

  it('cancels a running search in the worker', async () => {
    const { page, worker, close } = channel();
    let aborted = false;
    const slow: WorkspaceIndexEngine = {
      ...createMemoryEngine(),
      search: (_documents, _query, options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('stopped'));
          });
        }),
    };
    serveWorkspaceIndexEngine(worker, async () => served(slow));
    const engine = createWorkerEngine(page, { workspaceKey: 'w3', persist: false });
    await engine.opened;
    const controller = new AbortController();
    const search = engine
      .search([], { text: 'x' }, { checkpoint: () => Promise.resolve(), signal: controller.signal })
      .catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const failure = (await search) as Error;
    expect(failure.name).to.equal('AbortError');
    expect(aborted).to.equal(true);
    engine.dispose();
    close();
  });

  it('fails what is still pending when disposed', async () => {
    const { page, worker, close } = channel();
    const stuck: WorkspaceIndexEngine = {
      ...createMemoryEngine(),
      restore: () => new Promise(() => undefined),
    };
    serveWorkspaceIndexEngine(worker, async () => served(stuck));
    let terminated = false;
    const engine = createWorkerEngine(
      page,
      { workspaceKey: 'w4', persist: false },
      { onDispose: () => (terminated = true) },
    );
    await engine.opened;
    const restore = engine.restore().catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    engine.dispose();
    expect(((await restore) as Error).message).to.include('closed');
    expect(terminated).to.equal(true);
    const later = await engine.find('x').catch((error: unknown) => error);
    expect((later as Error).message).to.include('closed');
    close();
  });

  it('falls back to the in-memory engine when the store cannot open', async () => {
    const { page, worker, close } = channel();
    serveWorkspaceIndexEngine(worker, () => Promise.reject(new Error('No storage here.')));
    const provider = new MemoryFileSystemProviderV2('fallback', 'Fallback');
    await provider.writeFile(parseWorkspacePath('a.md'), encode('# Alpha\n\nheron\n'));
    const engine = withMemoryFallback(
      createWorkerEngine(page, { workspaceKey: 'w5', persist: true }),
      createMemoryEngine,
    );
    const index = createWorkspaceIndex({
      workspaceId: 'w5',
      source: provider,
      engine,
      yieldControl: () => Promise.resolve(),
      changeCoalesceMs: 0,
    });
    index.start();
    await ready(index);
    expect(await engine.opened).to.deep.equal({ persistence: 'memory', reset: null, ranks: false });
    expect(index.getStatus().ranked).to.equal(false);
    expect(index.getDocument('a.md')?.content).to.equal('full');
    expect((await index.search({ text: 'heron' })).documents).to.have.length(1);
    expect(await engine.find('heron')).to.deep.equal([]);
    index.dispose();
    close();
  });

  it('fails pending work and switches over when the worker dies', async () => {
    const { page, worker, close, crash } = channel();
    const stuck: WorkspaceIndexEngine = {
      ...createMemoryEngine(),
      analyze: () => new Promise(() => undefined),
    };
    serveWorkspaceIndexEngine(worker, async () => served(stuck));
    const raw = createWorkerEngine(page, { workspaceKey: 'w6', persist: false });
    const engine = withMemoryFallback(raw, createMemoryEngine);
    await engine.opened;
    const identity = {
      path: parseWorkspacePath('a.md'),
      sourcePath: parseWorkspacePath('a.md'),
      format: 'markdown' as const,
      lastModified: new Date(0).toISOString(),
    };
    const analysis = engine.analyze(identity, 'v1' as never, encode('# Alpha\n').buffer, {
      maxParseBytes: 1_000_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    crash();
    expect((await analysis).record.title).to.equal('Alpha');
    const direct = await raw.restore().catch((error: unknown) => error);
    expect((direct as Error).message).to.match(/stopped|closed/);
    engine.dispose();
    close();
  });

  it('carries embedding work and query vectors across the channel', async () => {
    const { page, worker, close } = channel();
    const stored: Array<{ hash: string; vector: number[] }> = [];
    let findVector: unknown = null;
    serveWorkspaceIndexEngine(worker, async () => ({
      engine: Object.assign(createMemoryEngine(), {
        find: (_query: string, options?: { vector?: Float32Array }) => {
          findVector = options?.vector ?? null;
          return [];
        },
        pendingEmbeddings: (limit = 64) =>
          [
            { hash: 'a'.repeat(64), input: 'first passage' },
            { hash: 'b'.repeat(64), input: 'second passage' },
          ].slice(0, limit),
        storeEmbeddings: (entries: ReadonlyArray<{ hash: string; vector: ArrayLike<number> }>) => {
          for (const { hash, vector } of entries)
            stored.push({ hash, vector: [...Array.from(vector)] });
        },
        embeddingStats: () => ({ total: 2, embedded: stored.length }),
      }),
      opened: { persistence: 'memory', reset: null, ranks: true },
    }));
    const engine = createWorkerEngine(page, {
      workspaceKey: 'w-semantic',
      persist: false,
      semantic: { profileId: 'bge-small-en-v1.5@1' },
    });
    await engine.opened;

    expect(await engine.pendingEmbeddings(1)).to.deep.equal([
      { hash: 'a'.repeat(64), input: 'first passage' },
    ]);
    // The caller's arrays stay usable: the client transfers copies.
    const vector = [0.5, -0.25, 1];
    await engine.storeEmbeddings([{ hash: 'a'.repeat(64), vector }]);
    expect(vector).to.deep.equal([0.5, -0.25, 1]);
    expect(stored).to.deep.equal([{ hash: 'a'.repeat(64), vector: [0.5, -0.25, 1] }]);
    expect(await engine.embeddingStats()).to.deep.equal({ total: 2, embedded: 1 });

    await engine.find('heron', { vector: [1, 0, 0] });
    expect(findVector).to.be.instanceOf(Float32Array);
    expect(Array.from(findVector as Float32Array)).to.deep.equal([1, 0, 0]);
    engine.dispose();
    close();
  });

  it('reports nothing to embed once fallen back to memory', async () => {
    const { page, worker, close } = channel();
    serveWorkspaceIndexEngine(worker, () => Promise.reject(new Error('No storage here.')));
    const engine = withMemoryFallback(
      createWorkerEngine(page, { workspaceKey: 'w-fallback', persist: true }),
      () => createMemoryEngine(),
    );
    expect(await engine.pendingEmbeddings()).to.deep.equal([]);
    expect(await engine.embeddingStats()).to.deep.equal({ total: 0, embedded: 0 });
    await engine.storeEmbeddings([{ hash: 'c'.repeat(64), vector: [1] }]);
    engine.dispose();
    close();
  });
});
