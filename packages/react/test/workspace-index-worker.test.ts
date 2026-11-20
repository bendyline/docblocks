import { expect } from 'chai';
import { MemoryFileSystemProviderV2 } from '@bendyline/docblocks/filesystem/memory';
import { parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import {
  createWorkerEngine,
  createWorkspaceIndex,
  type EngineHost,
  type EnginePort,
  type WorkspaceIndex,
} from '@bendyline/docblocks/workspace-index';
import { startWorkspaceIndexWorker } from '../src/WorkspaceIndex/worker.js';
import {
  startEmbeddingScheduler,
  type WorkspaceIndexEmbedder,
} from '../src/WorkspaceIndex/embedding-scheduler.js';

/** Stand-in embedder: a seeded direction per word, summed (the index normalizes). */
function bagOfWords(text: string): Float32Array {
  const out = new Float32Array(384);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let seed = 2166136261;
    for (const character of word) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
    for (let i = 0; i < out.length; i++) {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      out[i] = (out[i] as number) + (((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5);
    }
  }
  if (out.every((value) => value === 0)) out[0] = 1;
  return out;
}

const encode = (text: string) => new TextEncoder().encode(text);

async function ready(index: WorkspaceIndex): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const status = index.getStatus();
    if (status.phase === 'ready' && status.pendingCount === 0 && status.ranked) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`index never settled: ${JSON.stringify(index.getStatus())}`);
}

describe('workspace index worker', () => {
  const ports: MessagePort[] = [];
  afterEach(() => {
    for (const port of ports.splice(0)) port.close();
  });

  it('serves the index over sqlite-wasm and the live index, in memory without OPFS', async () => {
    const { port1, port2 } = new MessageChannel();
    port1.start();
    port2.start();
    ports.push(port1, port2);
    // Node stands in for the worker: real sqlite-wasm, no origin-private storage.
    startWorkspaceIndexWorker(port2 as unknown as EngineHost);

    const provider = new MemoryFileSystemProviderV2('worker-test', 'Worker test');
    await provider.writeFile(
      parseWorkspacePath('garden.md'),
      encode('# Garden notes\n\n## Pests\n\nAphids gather under the leaves.\n'),
    );
    await provider.writeFile(
      parseWorkspacePath('kitchen.md'),
      encode('# Kitchen\n\nRoast tomatoes.\n'),
    );

    const engine = createWorkerEngine(port1 as unknown as EnginePort, {
      workspaceKey: 'test:worker',
      persist: true,
    });
    const index = createWorkspaceIndex({
      workspaceId: 'worker',
      source: provider,
      engine,
      yieldControl: () => Promise.resolve(),
      changeCoalesceMs: 0,
    });
    index.start();
    await ready(index);

    expect(await engine.opened).to.deep.equal({ persistence: 'memory', reset: null, ranks: true });
    const literal = await index.search({ text: 'Aphids', matchCase: true });
    expect(literal.documents.map((document) => document.path)).to.deep.equal(['garden.md']);
    const [passage] = (await index.find?.('aphid leaves')) ?? [];
    expect(passage).to.include({ path: 'garden.md' });
    expect(passage?.headingPath).to.deep.equal(['Garden notes', 'Pests']);
    index.dispose();
  });

  it('embeds passages through the worker and ranks by meaning', async () => {
    const { port1, port2 } = new MessageChannel();
    port1.start();
    port2.start();
    ports.push(port1, port2);
    // A word-level tokenizer stands in for bge's: one token per word.
    const tokenizer = {
      version: '1.0',
      truncation: null,
      padding: null,
      added_tokens: [],
      normalizer: null,
      pre_tokenizer: { type: 'Whitespace' },
      post_processor: null,
      decoder: null,
      model: { type: 'WordLevel', vocab: { '[UNK]': 0 }, unk_token: '[UNK]' },
    };
    const dataUrl = (value: object) =>
      `data:application/json;base64,${Buffer.from(JSON.stringify(value)).toString('base64')}`;
    startWorkspaceIndexWorker(port2 as unknown as EngineHost, {
      tokenizers: {
        'bge-small-en-v1.5@1': { definitionUrl: dataUrl(tokenizer), configUrl: dataUrl({}) },
      },
    });

    const provider = new MemoryFileSystemProviderV2('semantic-test', 'Semantic test');
    await provider.writeFile(
      parseWorkspacePath('garden.md'),
      encode(
        '# Garden notes\n\n## Pests\n\nAphids gather under the leaves; soap spray clears them.\n',
      ),
    );
    await provider.writeFile(
      parseWorkspacePath('kitchen.md'),
      encode('# Kitchen\n\nRoast tomatoes slowly with garlic and thyme.\n'),
    );
    const embedder: WorkspaceIndexEmbedder = {
      profileId: 'bge-small-en-v1.5@1',
      embed: async (_kind, texts) => texts.map((text) => bagOfWords(text)),
    };
    const engine = createWorkerEngine(port1 as unknown as EnginePort, {
      workspaceKey: 'test:semantic',
      persist: false,
      semantic: { profileId: embedder.profileId },
    });
    const index = createWorkspaceIndex({
      workspaceId: 'semantic',
      source: provider,
      engine,
      yieldControl: () => Promise.resolve(),
      changeCoalesceMs: 0,
      embedQuery: async (query) => bagOfWords(query),
    });
    index.start();
    await ready(index);
    let progress = { total: 0, embedded: 0 };
    const stop = startEmbeddingScheduler({
      store: engine,
      embedder,
      index,
      onProgress: (value) => {
        progress = value;
      },
      paused: () => false,
      delays: { idle: 20, retry: 20, settle: 5 },
    });
    for (
      let attempt = 0;
      attempt < 500 && !(progress.total > 0 && progress.embedded === progress.total);
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stop();
    expect(progress.total).to.be.greaterThan(0);
    expect(progress.embedded).to.equal(progress.total);

    // No query word appears in the garden note's text beyond "aphids"; meaning carries it.
    const hits = (await index.find?.('aphids leaves pests garden notes soap spray')) ?? [];
    expect(hits[0]?.path).to.equal('garden.md');
    expect(hits[0]?.meaning).to.equal(true);
    expect(hits[0]?.text).to.equal(undefined);
    // Asked for, each passage carries its full text (to quote it to a model).
    const quoted =
      (await index.find?.('aphids leaves pests garden notes soap spray', { text: true })) ?? [];
    expect(quoted[0]?.text).to.contain('Aphids gather under the leaves');
    index.dispose();
  });
});
