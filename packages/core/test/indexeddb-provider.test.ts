import { expect } from 'chai';
import { IndexedDBFileSystemProvider } from '../src/filesystem/indexeddb-provider.js';
import { FsError } from '../src/filesystem/fs-error.js';
import { parseWorkspacePath } from '../src/filesystem/workspace-path.js';
import { defineFileSystemProviderV1Conformance } from './helpers/filesystem-v1-conformance.js';
import type {
  IndexedDBFileSystemStore,
  IndexedDBFileSystemTransaction,
  IndexedDBFileSystemTransactionMode,
} from '../src/filesystem/indexeddb-store.js';

type StoreOperation = 'get' | 'put' | 'delete' | 'keys';

interface InjectedFailure {
  operation: StoreOperation;
  key?: string;
  remaining: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForActiveWrite(store: FakeTransactionalStore): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (store.activeWriteCount > 0) return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for the IndexedDB write transaction to start.');
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

class FakeTransactionalStore implements IndexedDBFileSystemStore {
  private values = new Map<string, unknown>();
  private failure: InjectedFailure | null = null;
  private nextWritePause: Promise<void> | null = null;
  private activeWriteTransactions = 0;
  public maxActiveWriteTransactions = 0;
  public closeCalls = 0;
  private closed = false;

  public get activeWriteCount(): number {
    return this.activeWriteTransactions;
  }

  public seed(key: string, value: unknown): void {
    this.values.set(key, cloneValue(value));
  }

  public snapshot(): Map<string, unknown> {
    return new Map([...this.values].map(([key, value]) => [key, cloneValue(value)]));
  }

  public failNext(operation: StoreOperation, key?: string): void {
    this.failure = { operation, key, remaining: 1 };
  }

  public pauseNextWriteUntil(promise: Promise<void>): void {
    this.nextWritePause = promise;
  }

  public async transaction<T>(
    mode: IndexedDBFileSystemTransactionMode,
    operation: (transaction: IndexedDBFileSystemTransaction) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new Error('Store is closed.');
    const writable = mode === 'readwrite';
    const working = writable ? this.snapshot() : this.values;
    if (writable) {
      this.activeWriteTransactions += 1;
      this.maxActiveWriteTransactions = Math.max(
        this.maxActiveWriteTransactions,
        this.activeWriteTransactions,
      );
    }
    const pause = writable ? this.nextWritePause : null;
    if (pause) this.nextWritePause = null;

    const transaction: IndexedDBFileSystemTransaction = {
      get: async <V>(key: string) => {
        this.maybeFail('get', key);
        const value = working.get(key);
        return value === undefined ? null : cloneValue(value as V);
      },
      put: async <V>(key: string, value: V) => {
        this.maybeFail('put', key);
        working.set(key, cloneValue(value));
      },
      delete: async (key: string) => {
        this.maybeFail('delete', key);
        working.delete(key);
      },
      keys: async () => {
        this.maybeFail('keys');
        return [...working.keys()];
      },
      hasKeyWithPrefix: async (prefix: string) => {
        this.maybeFail('keys');
        return [...working.keys()].some((key) => key.startsWith(prefix));
      },
    };

    try {
      if (pause) await pause;
      const result = await operation(transaction);
      if (writable) this.values = working;
      return result;
    } finally {
      if (writable) this.activeWriteTransactions -= 1;
    }
  }

  public close(): void {
    this.closeCalls += 1;
    this.closed = true;
  }

  private maybeFail(operation: StoreOperation, key?: string): void {
    if (
      !this.failure ||
      this.failure.operation !== operation ||
      (this.failure.key !== undefined && this.failure.key !== key)
    ) {
      return;
    }
    this.failure.remaining -= 1;
    if (this.failure.remaining <= 0) this.failure = null;
    throw new Error(`Injected ${operation} failure${key ? ` for ${key}` : ''}`);
  }
}

let providerSequence = 0;

function createProvider(
  store = new FakeTransactionalStore(),
  id = `indexeddb-test-${providerSequence++}`,
): { provider: IndexedDBFileSystemProvider; store: FakeTransactionalStore } {
  const provider = new IndexedDBFileSystemProvider(id, 'Test', {
    store,
    now: () => new Date('2026-07-11T12:00:00.000Z'),
  });
  return { provider, store };
}

async function expectRejected(operation: Promise<unknown>, message: RegExp): Promise<void> {
  try {
    await operation;
    expect.fail('Expected operation to reject.');
  } catch (error: unknown) {
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.match(message);
  }
}

describe('IndexedDBFileSystemProvider', () => {
  it('writes text with canonical metadata and creates parent directories atomically', async () => {
    const { provider } = createProvider();

    await provider.writeFile('/notes/daily/today.md', '# Today');

    expect(await provider.readFile('notes/daily/today.md')).to.equal('# Today');
    expect(await provider.exists('/notes')).to.equal(true);
    expect(await provider.exists('/notes/daily')).to.equal(true);
    expect(await provider.stat('/notes/daily/today.md')).to.deep.equal({
      name: 'today.md',
      path: 'notes/daily/today.md',
      size: 7,
      lastModified: '2026-07-11T12:00:00.000Z',
    });
    expect(await provider.readDirectory('/notes')).to.deep.equal([
      { kind: 'directory', name: 'daily', path: 'notes/daily' },
    ]);
  });

  it('keeps exactly one payload and copies only visible Uint8Array bytes', async () => {
    const { provider } = createProvider();
    const backing = new Uint8Array([1, 2, 3, 4]).buffer;

    await provider.writeBinary('/payload', new Uint8Array(backing, 1, 2));
    expect(Array.from(new Uint8Array((await provider.readBinary('/payload'))!))).to.deep.equal([
      2, 3,
    ]);
    expect(await provider.readFile('/payload')).to.equal(
      new TextDecoder().decode(new Uint8Array([2, 3])),
    );

    await provider.writeFile('/payload', 'text');
    expect(await provider.readFile('/payload')).to.equal('text');
    expect(new TextDecoder().decode((await provider.readBinary('/payload'))!)).to.equal('text');

    await provider.writeBinary('/payload', new Uint8Array([9]));
    expect(await provider.readFile('/payload')).to.equal(
      new TextDecoder().decode(new Uint8Array([9])),
    );
    expect(Array.from(new Uint8Array((await provider.readBinary('/payload'))!))).to.deep.equal([9]);
  });

  it('rejects traversal, NUL, and root mutation targets', async () => {
    const { provider } = createProvider();

    await expectRejected(provider.writeFile('../escape.md', 'x'), /must not contain/);
    await expectRejected(provider.createDirectory('safe/./bad'), /must not contain/);
    await expectRejected(provider.delete('/'), /root is not a file entry/);
    await expectRejected(provider.writeBinary('bad\0name', new Uint8Array()), /NUL/);
    expect(await provider.readDirectory('/')).to.deep.equal([]);
    expect(await provider.exists('/')).to.equal(true);
  });

  it('prevents file/directory and ancestor-kind collisions', async () => {
    const { provider } = createProvider();
    await provider.createDirectory('/folder');
    await expectRejected(provider.writeFile('/folder', 'x'), /directory/);

    await provider.writeFile('/file', 'x');
    await expectRejected(provider.createDirectory('/file'), /file/);
    await expectRejected(provider.writeFile('/file/child.md', 'x'), /is a file/);
    await expectRejected(provider.readDirectory('/file'), /directory/);
  });

  it('deletes a directory tree and every file record in one operation', async () => {
    const { provider } = createProvider();
    await provider.writeFile('/tree/a.md', 'a');
    await provider.writeBinary('/tree/nested/b.bin', new Uint8Array([1]));

    await provider.delete('/tree');

    expect(await provider.exists('/tree')).to.equal(false);
    expect(await provider.exists('/tree/a.md')).to.equal(false);
    expect(await provider.exists('/tree/nested/b.bin')).to.equal(false);
    expect(await provider.readDirectory('/')).to.deep.equal([]);
  });

  it('renames files and directory trees without leaving source records', async () => {
    const { provider } = createProvider();
    await provider.writeFile('/old.md', 'old');
    await provider.rename('/old.md', '/docs/new.md');
    expect(await provider.readFile('/old.md')).to.equal(null);
    expect(await provider.readFile('/docs/new.md')).to.equal('old');
    expect((await provider.stat('/docs/new.md'))?.path).to.equal('docs/new.md');

    await provider.writeFile('/from/child.md', 'child');
    await provider.writeBinary('/from/nested/image.bin', new Uint8Array([7, 8]));
    await provider.createDirectory('/from/empty');
    await provider.rename('/from', '/archive/to');

    expect(await provider.exists('/from')).to.equal(false);
    expect(await provider.readFile('/archive/to/child.md')).to.equal('child');
    expect(
      Array.from(new Uint8Array((await provider.readBinary('/archive/to/nested/image.bin'))!)),
    ).to.deep.equal([7, 8]);
    expect(await provider.exists('/archive/to/empty')).to.equal(true);
  });

  it('rejects missing sources, existing destinations, and moves into descendants', async () => {
    const { provider } = createProvider();
    await provider.writeFile('/a.md', 'a');
    await provider.writeFile('/b.md', 'b');
    await provider.createDirectory('/dir/child');

    await expectRejected(provider.rename('/missing.md', '/x.md'), /Source does not exist/);
    await expectRejected(provider.rename('/a.md', '/b.md'), /Destination already exists/);
    await expectRejected(provider.rename('/dir', '/dir/child/new'), /into itself/);
    expect(await provider.readFile('/a.md')).to.equal('a');
    expect(await provider.readFile('/b.md')).to.equal('b');
  });

  it('lets only one concurrent conditional commit win for a shared workspace id', async () => {
    const store = new FakeTransactionalStore();
    const id = `shared-${providerSequence++}`;
    const first = createProvider(store, id).provider;
    const second = createProvider(store, id).provider;
    await first.writeFile('/doc.md', 'base');

    const [left, right] = await Promise.all([
      first.commitFile('/doc.md', 'left', 'base'),
      second.commitFile('/doc.md', 'right', 'base'),
    ]);

    expect([left.status, right.status].sort()).to.deep.equal(['committed', 'conflict']);
    expect(['left', 'right']).to.include(await first.readFile('/doc.md'));
  });

  it('propagates correctness-critical get and keys failures', async () => {
    const { provider, store } = createProvider();
    await provider.writeFile('/doc.md', 'content');

    store.failNext('get', 'v2:entry:doc.md');
    await expectRejected(provider.readFile('/doc.md'), /Injected get failure/);

    store.failNext('keys');
    try {
      await provider.readDirectory('/');
      expect.fail('Expected enumeration to reject.');
    } catch (error: unknown) {
      expect(error).to.be.instanceOf(FsError);
      expect(error).to.deep.include({ code: 'io', operation: 'list', retryable: true });
      expect((error as Error).message).to.match(/Injected keys failure/);
    }
  });

  it('rolls back a failed multi-record text write', async () => {
    const { provider, store } = createProvider();
    await provider.writeBinary('/doc', new Uint8Array([4, 5]));
    const before = store.snapshot();
    store.failNext('put', 'v2:state');

    await expectRejected(provider.writeFile('/doc', 'replacement'), /Injected put failure/);

    expect(store.snapshot()).to.deep.equal(before);
    expect(Array.from(new Uint8Array((await provider.readBinary('/doc'))!))).to.deep.equal([4, 5]);
    expect(await provider.readFile('/doc')).to.equal(
      new TextDecoder().decode(new Uint8Array([4, 5])),
    );
  });

  it('rolls back delete when any record removal fails', async () => {
    const { provider, store } = createProvider();
    await provider.writeFile('/tree/a.md', 'a');
    await provider.writeFile('/tree/b.md', 'b');
    const before = store.snapshot();
    store.failNext('delete', 'v2:entry:tree/a.md');

    await expectRejected(provider.delete('/tree'), /Injected delete failure/);

    expect(store.snapshot()).to.deep.equal(before);
    expect(await provider.readFile('/tree/a.md')).to.equal('a');
    expect(await provider.readFile('/tree/b.md')).to.equal('b');
  });

  it('rolls back rename when destination creation or source deletion fails', async () => {
    const { provider, store } = createProvider();
    await provider.writeFile('/source.md', 'source');
    const before = store.snapshot();
    store.failNext('delete', 'v2:entry:source.md');

    await expectRejected(provider.rename('/source.md', '/target.md'), /Injected delete failure/);

    expect(store.snapshot()).to.deep.equal(before);
    expect(await provider.readFile('/source.md')).to.equal('source');
    expect(await provider.readFile('/target.md')).to.equal(null);
  });

  it('serializes writeBinary and createDirectory with every other workspace mutation', async () => {
    const { provider, store } = createProvider();
    const gate = deferred<void>();
    store.pauseNextWriteUntil(gate.promise);

    const binary = provider.writeBinary('/data.bin', new Uint8Array([1]));
    await Promise.resolve();
    const directory = provider.createDirectory('/created');
    await Promise.resolve();
    expect(store.maxActiveWriteTransactions).to.equal(1);

    gate.resolve(undefined);
    await Promise.all([binary, directory]);
    expect(store.maxActiveWriteTransactions).to.equal(1);
    expect(await provider.exists('/created')).to.equal(true);
  });

  it('surfaces corrupt directory indexes and exposes divergent legacy bytes for recovery', async () => {
    const corruptDirectories = new FakeTransactionalStore();
    corruptDirectories.seed('fs:dirs', ['ok', '../bad']);
    const first = createProvider(corruptDirectories).provider;
    await expectRejected(first.readDirectory('/'), /must not contain/);

    const duplicatePayload = new FakeTransactionalStore();
    duplicatePayload.seed('fs:doc:content', 'text');
    duplicatePayload.seed('fs:doc:binary', new Uint8Array([1]).buffer);
    duplicatePayload.seed('fs:doc:meta', {
      name: 'doc',
      path: 'doc',
      size: 1,
      lastModified: '2026-07-11T12:00:00.000Z',
    });
    const second = createProvider(duplicatePayload).provider;
    expect(await second.readFile('/doc')).to.equal(null);
    expect(await second.readBinary('/doc')).to.equal(null);
    const conflicts = await second.v2.listLegacyMigrationConflicts();
    expect(conflicts).to.have.length(1);
    expect(conflicts[0]).to.deep.include({ text: 'text', reason: 'dual-payload' });
    expect(Array.from(new Uint8Array(conflicts[0]!.binary!))).to.deep.equal([1]);
    expect(await second.commitFile('/doc', 'changed', 'text')).to.deep.include({
      status: 'conflict',
      content: null,
    });

    await second.v2.resolveLegacyMigrationConflict(parseWorkspacePath('/doc'), 'text');
    expect(await second.readFile('/doc')).to.equal('text');
  });

  it('preserves both legacy payloads under a directory until authority is chosen', async () => {
    const legacy = new FakeTransactionalStore();
    legacy.seed('fs:dirs', ['folder']);
    legacy.seed('fs:folder/doc:content', 'text');
    legacy.seed('fs:folder/doc:binary', new Uint8Array([2, 3]).buffer);
    legacy.seed('fs:folder/doc:meta', {
      name: 'doc',
      path: 'folder/doc',
      size: 2,
      lastModified: '2026-07-11T12:00:00.000Z',
    });
    const provider = createProvider(legacy).provider;

    const conflicts = await provider.v2.listLegacyMigrationConflicts();
    expect(conflicts).to.have.length(1);
    expect(conflicts[0]).to.deep.include({ path: 'folder/doc', text: 'text' });
    expect(Array.from(new Uint8Array(conflicts[0]!.binary!))).to.deep.equal([2, 3]);
    await provider.v2.resolveLegacyMigrationConflict(parseWorkspacePath('/folder/doc'), 'text');
    await provider.rename('/folder', '/archive');

    expect(await provider.readFile('/archive/doc')).to.equal('text');
    expect(await provider.exists('/folder')).to.equal(false);
  });

  it('disposes the concrete store idempotently and rejects later operations', async () => {
    const { provider, store } = createProvider();
    await provider.writeFile('/doc.md', 'content');

    await provider.dispose();
    await provider.dispose();

    expect(store.closeCalls).to.equal(1);
    await expectRejected(provider.readFile('/doc.md'), /disposed/);
    await expectRejected(provider.writeFile('/next.md', 'next'), /disposed/);

    // Callers switch on the code, not the message. Every v2 provider reports
    // 'disposed' for this exact condition, so this facade must not report a
    // different code for it. ('closed' remains distinct: the Electron transport
    // uses it for a host-side session that closed underneath the client.)
    for (const operation of [
      () => provider.readFile('/doc.md'),
      () => provider.stat('/doc.md'),
      () => provider.readDirectory('/'),
      () => provider.writeFile('/next.md', 'next'),
      () => provider.delete('/doc.md'),
    ]) {
      const error = await operation().then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).to.be.instanceOf(FsError);
      expect((error as FsError).code).to.equal('disposed');
    }
  });

  it('waits for an already-started shared transaction before closing exactly once', async () => {
    const { provider, store } = createProvider();
    await provider.v2.snapshot();
    const gate = deferred<void>();
    store.pauseNextWriteUntil(gate.promise);

    const write = provider.writeFile('/doc.md', 'committed before close');
    await waitForActiveWrite(store);
    const closing = provider.dispose();
    expect(store.closeCalls).to.equal(0);
    await expectRejected(provider.readFile('/doc.md'), /disposed/);

    gate.resolve(undefined);
    await write;
    await closing;
    await provider.dispose();

    expect(store.closeCalls).to.equal(1);
    expect(store.snapshot().has('v2:entry:doc.md')).to.equal(true);
  });

  it('does not mutate storage when enumeration fails before a delete or rename', async () => {
    const { provider, store } = createProvider();
    await provider.writeFile('/doc.md', 'content');
    const beforeDelete = store.snapshot();
    store.failNext('keys');
    await expectRejected(provider.delete('/doc.md'), /Injected keys failure/);
    expect(store.snapshot()).to.deep.equal(beforeDelete);

    const beforeRename = store.snapshot();
    store.failNext('keys');
    await expectRejected(provider.rename('/doc.md', '/next.md'), /Injected keys failure/);
    expect(store.snapshot()).to.deep.equal(beforeRename);
  });
});

defineFileSystemProviderV1Conformance(
  'IndexedDBFileSystemProvider',
  () => createProvider().provider,
);
