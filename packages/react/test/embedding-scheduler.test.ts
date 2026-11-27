import { expect } from 'chai';
import type { LivePendingPassage } from '@bendyline/docblocks/workspace-index';
import {
  startEmbeddingScheduler,
  type SemanticProgress,
  type WorkspaceIndexEmbedder,
} from '../src/WorkspaceIndex/embedding-scheduler.js';

const delays = { idle: 50, retry: 20, settle: 5 };

/** A store holding `count` passages to embed. */
function fakeStore(count: number) {
  const pending: LivePendingPassage[] = Array.from({ length: count }, (_, n) => ({
    hash: n.toString(16).padStart(64, '0'),
    input: `passage ${n}`,
  }));
  const stored = new Map<string, ArrayLike<number>>();
  return {
    stored,
    add(input: string) {
      pending.push({ hash: (count + pending.length).toString(16).padStart(64, '0'), input });
    },
    async pendingEmbeddings(limit = 16) {
      return pending.filter((passage) => !stored.has(passage.hash)).slice(0, limit);
    },
    async storeEmbeddings(entries: ReadonlyArray<{ hash: string; vector: ArrayLike<number> }>) {
      for (const { hash, vector } of entries) stored.set(hash, vector);
    },
    async embeddingStats() {
      return { total: pending.length, embedded: stored.size };
    },
  };
}

function fakeIndex() {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish: () => listeners.forEach((listener) => listener()),
  };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out: ${label}`);
}

describe('embedding scheduler', () => {
  it('embeds every pending passage in batches and reports progress', async () => {
    const store = fakeStore(40);
    const batches: number[] = [];
    const embedder: WorkspaceIndexEmbedder = {
      profileId: 'test',
      embed: async (_kind, texts) => {
        batches.push(texts.length);
        return texts.map((text) => [text.length, 1]);
      },
    };
    const progress: SemanticProgress[] = [];
    const stop = startEmbeddingScheduler({
      store,
      embedder,
      index: fakeIndex(),
      onProgress: (value) => progress.push(value),
      paused: () => false,
      batchSize: 16,
      delays,
    });
    await until(
      () => progress.at(-1)?.working === false && store.stored.size === 40,
      'all embedded',
    );
    stop();
    expect(batches).to.deep.equal([16, 16, 8]);
    expect(progress.at(-1)).to.deep.equal({ total: 40, embedded: 40, working: false });
    expect(progress.some((value) => value.working)).to.equal(true);
  });

  it('waits while paused, retries a failing embedder, and wakes when the index changes', async () => {
    const store = fakeStore(2);
    let paused = true;
    let failures = 1;
    const embedder: WorkspaceIndexEmbedder = {
      profileId: 'test',
      embed: async (_kind, texts) => {
        if (failures-- > 0) throw new Error('model still loading');
        return texts.map(() => [1, 0]);
      },
    };
    const index = fakeIndex();
    const stop = startEmbeddingScheduler({
      store,
      embedder,
      index,
      onProgress: () => undefined,
      paused: () => paused,
      delays,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(store.stored.size).to.equal(0);
    paused = false;
    await until(() => store.stored.size === 2, 'embedded after resuming and one retry');

    store.add('a new passage');
    index.publish();
    await until(() => store.stored.size === 3, 'woken by the index');
    stop();
  });

  it('stops embedding once stopped', async () => {
    const store = fakeStore(100);
    let calls = 0;
    const stop = startEmbeddingScheduler({
      store,
      embedder: {
        profileId: 'test',
        embed: async (_kind, texts) => {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return texts.map(() => [1]);
        },
      },
      index: fakeIndex(),
      onProgress: () => undefined,
      paused: () => false,
      batchSize: 4,
      delays,
    });
    await until(() => calls >= 1, 'first batch');
    stop();
    const after = calls;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls - after).to.be.at.most(1);
  });
});
