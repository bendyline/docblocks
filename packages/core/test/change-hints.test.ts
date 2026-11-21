import { expect } from 'chai';
import {
  openFileSystemChangeChannel,
  publishFileSystemChangeHint,
  subscribeFileSystemChangeHints,
  type FileSystemChangeHint,
} from '../src/filesystem/change-hints.js';
import { IndexedDBFileSystemProviderV2, parseWorkspacePath } from '../src/filesystem/index.js';
import {
  childKeyStep,
  type IndexedDBFileSystemStore,
  type IndexedDBFileSystemTransaction,
} from '../src/filesystem/indexeddb-store.js';

/** One database shared by every "tab" in a test: a plain map with serialized transactions. */
class SharedStore implements IndexedDBFileSystemStore {
  private values = new Map<string, unknown>();
  private tail: Promise<unknown> = Promise.resolve();

  public transaction<T>(
    mode: 'readonly' | 'readwrite',
    work: (transaction: IndexedDBFileSystemTransaction) => Promise<T>,
  ): Promise<T> {
    const run = this.tail.then(async () => {
      const working = mode === 'readwrite' ? new Map(this.values) : this.values;
      const sorted = () => [...working.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const result = await work({
        get: async <V>(key: string) => {
          const value = working.get(key);
          return value === undefined ? null : (structuredClone(value) as V);
        },
        put: async <V>(key: string, value: V) => {
          working.set(key, structuredClone(value));
        },
        delete: async (key: string) => {
          working.delete(key);
        },
        keys: async () => sorted(),
        hasKeyWithPrefix: async (prefix: string) =>
          [...working.keys()].some((key) => key.startsWith(prefix)),
        childKeys: async (prefix: string) => {
          const found: string[] = [];
          for (const key of sorted()) {
            const step = childKeyStep(prefix, key);
            if (step.kind === 'done') break;
            if (step.kind === 'child') found.push(key);
          }
          return found;
        },
      });
      if (mode === 'readwrite') this.values = working;
      return result;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const bytes = (text: string) => new TextEncoder().encode(text);

describe('filesystem change hints', () => {
  it('delivers a hint to every subscriber and survives one that throws', () => {
    const seen: FileSystemChangeHint[] = [];
    const stopBroken = subscribeFileSystemChangeHints(() => {
      throw new Error('consumer failed');
    });
    const stop = subscribeFileSystemChangeHints((hint) => seen.push(hint));
    publishFileSystemChangeHint('workspace-a');
    publishFileSystemChangeHint();
    stop();
    stop();
    stopBroken();
    publishFileSystemChangeHint('after-unsubscribe');
    expect(seen).to.deep.equal([{ providerId: 'workspace-a' }, { providerId: null }]);
  });

  it('tells other tabs, never the one that wrote', async () => {
    const name = `docblocks:test:${Date.now()}:${Math.random()}`;
    const seen: Array<string | null> = [];
    const stop = subscribeFileSystemChangeHints((hint) => seen.push(hint.providerId));
    const here = openFileSystemChangeChannel(name, 'here');
    const there = openFileSystemChangeChannel(name, 'there');
    expect(here).not.to.equal(null);
    here!.announce();
    await wait();
    // Only the other tab's channel heard it, and reports it for its own provider.
    expect(seen).to.deep.equal(['there']);
    here!.close();
    here!.close();
    there!.announce();
    await wait();
    expect(seen).to.deep.equal(['there']);
    there!.close();
    stop();
  });

  it('turns a write in one tab into a hint in another tab on the same workspace', async () => {
    const id = `hints-${Date.now()}-${Math.random()}`;
    const store = new SharedStore();
    const options = { store, closeStoreOnDispose: false };
    const tabA = new IndexedDBFileSystemProviderV2(id, 'Tab A', options);
    const tabB = new IndexedDBFileSystemProviderV2(id, 'Tab B', options);
    const elsewhere = new IndexedDBFileSystemProviderV2(`${id}-other`, 'Other workspace', {
      store: new SharedStore(),
    });
    const seen: Array<string | null> = [];
    const stop = subscribeFileSystemChangeHints((hint) => seen.push(hint.providerId));
    try {
      await tabA.stat(parseWorkspacePath('note.md'));
      await tabB.stat(parseWorkspacePath('note.md'));
      await wait();
      seen.length = 0;

      await tabA.writeFile(parseWorkspacePath('note.md'), bytes('from tab A'));
      await wait();
      expect(seen).to.deep.equal([id]);
      // Reading announces nothing, so tabs cannot ping each other forever.
      await tabB.readFile(parseWorkspacePath('note.md'));
      await tabB.readDirectory(parseWorkspacePath(''));
      await wait();
      expect(seen).to.deep.equal([id]);

      await elsewhere.writeFile(parseWorkspacePath('note.md'), bytes('unrelated'));
      await wait();
      expect(seen).to.deep.equal([id]);
    } finally {
      stop();
      await tabA.dispose();
      await tabB.dispose();
      await elsewhere.dispose();
    }
    // A disposed tab neither announces nor listens.
    const after: Array<string | null> = [];
    const stopAfter = subscribeFileSystemChangeHints((hint) => after.push(hint.providerId));
    const tabC = new IndexedDBFileSystemProviderV2(id, 'Tab C', options);
    await tabC.writeFile(parseWorkspacePath('later.md'), bytes('later'));
    await wait();
    expect(after).to.deep.equal([]);
    await tabC.dispose();
    stopAfter();
  });

  it('can be turned off for a provider', async () => {
    const id = `quiet-${Date.now()}-${Math.random()}`;
    const store = new SharedStore();
    const quiet = new IndexedDBFileSystemProviderV2(id, 'Quiet', {
      store,
      closeStoreOnDispose: false,
      announceChanges: false,
    });
    const listening = new IndexedDBFileSystemProviderV2(id, 'Listening', {
      store,
      closeStoreOnDispose: false,
    });
    const seen: Array<string | null> = [];
    const stop = subscribeFileSystemChangeHints((hint) => seen.push(hint.providerId));
    await listening.stat(parseWorkspacePath('a.md'));
    await wait();
    seen.length = 0;
    await quiet.writeFile(parseWorkspacePath('a.md'), bytes('quiet'));
    await wait();
    expect(seen).to.deep.equal([]);
    stop();
    await quiet.dispose();
    await listening.dispose();
  });
});
