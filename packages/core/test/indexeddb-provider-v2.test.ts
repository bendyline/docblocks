import { expect } from 'chai';
import {
  IndexedDBFileSystemProvider,
  IndexedDBFileSystemProviderV2,
  parseWorkspacePath,
} from '../src/filesystem/index.js';
import type {
  IndexedDBFileSystemStore,
  IndexedDBFileSystemTransaction,
  IndexedDBFileSystemTransactionMode,
} from '../src/filesystem/indexeddb-store.js';
import {
  defineFileSystemProviderV2Conformance,
  expectFsError,
} from './helpers/filesystem-v2-conformance.js';

type StoreOperation = 'get' | 'put' | 'delete' | 'keys';

interface InjectedFailure {
  readonly operation: StoreOperation;
  readonly key?: string;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeTransactionalStore implements IndexedDBFileSystemStore {
  private values = new Map<string, unknown>();
  private failure: InjectedFailure | null = null;
  private nextWritePause: Promise<void> | null = null;
  private activeWrites = 0;
  private closed = false;
  public closeCalls = 0;
  public keysCalls = 0;
  public prefixProbeCalls = 0;

  public seed(key: string, value: unknown): void {
    this.values.set(key, structuredClone(value));
  }

  public snapshot(): Map<string, unknown> {
    return new Map([...this.values].map(([key, value]) => [key, structuredClone(value)] as const));
  }

  public failNext(operation: StoreOperation, key?: string): void {
    this.failure = { operation, key };
  }

  public pauseNextWriteUntil(promise: Promise<void>): void {
    this.nextWritePause = promise;
  }

  public resetOperationCounts(): void {
    this.keysCalls = 0;
    this.prefixProbeCalls = 0;
  }

  public get activeWriteCount(): number {
    return this.activeWrites;
  }

  public async transaction<T>(
    mode: IndexedDBFileSystemTransactionMode,
    operation: (transaction: IndexedDBFileSystemTransaction) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new Error('Store is closed.');
    const writable = mode === 'readwrite';
    const working = writable ? this.snapshot() : this.values;
    const pause = writable ? this.nextWritePause : null;
    if (pause) this.nextWritePause = null;
    if (writable) this.activeWrites += 1;
    const transaction: IndexedDBFileSystemTransaction = {
      get: async <V>(key: string) => {
        this.maybeFail('get', key);
        const value = working.get(key);
        return value === undefined ? null : structuredClone(value as V);
      },
      put: async <V>(key: string, value: V) => {
        this.maybeFail('put', key);
        working.set(key, structuredClone(value));
      },
      delete: async (key: string) => {
        this.maybeFail('delete', key);
        working.delete(key);
      },
      keys: async () => {
        this.keysCalls += 1;
        this.maybeFail('keys');
        return [...working.keys()];
      },
      hasKeyWithPrefix: async (prefix: string) => {
        this.prefixProbeCalls += 1;
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
      if (writable) this.activeWrites -= 1;
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCalls += 1;
  }

  private maybeFail(operation: StoreOperation, key?: string): void {
    if (
      this.failure?.operation !== operation ||
      (this.failure.key !== undefined && this.failure.key !== key)
    ) {
      return;
    }
    this.failure = null;
    throw new Error(`Injected ${operation} failure${key ? ` for ${key}` : ''}.`);
  }
}

async function waitForActiveWrite(store: FakeTransactionalStore): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (store.activeWriteCount > 0) return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for the IndexedDB v2 write transaction to start.');
}

let providerSequence = 0;

function createProvider(store = new FakeTransactionalStore()): {
  readonly provider: IndexedDBFileSystemProviderV2;
  readonly store: FakeTransactionalStore;
} {
  const provider = new IndexedDBFileSystemProviderV2(
    `indexeddb-v2-test-${++providerSequence}`,
    'IndexedDB v2 test',
    {
      store,
      now: () => new Date('2026-07-11T12:00:00.000Z'),
    },
  );
  return { provider, store };
}

defineFileSystemProviderV2Conformance('IndexedDB', () => createProvider().provider);

describe('IndexedDBFileSystemProviderV2 migration and compatibility', () => {
  it('non-destructively cuts legacy text and binary payloads over to v2 authority', async () => {
    const store = new FakeTransactionalStore();
    store.seed('fs:dirs', ['docs']);
    seedLegacyText(store, 'docs/text.md', 'hello');
    seedLegacyBinary(store, 'asset.bin', new Uint8Array([0, 1, 255]));
    const { provider } = createProvider(store);

    expect(decode((await provider.readFile(p('/docs/text.md')))?.data)).to.equal('hello');
    expect(bytes((await provider.readFile(p('/asset.bin')))?.data)).to.deep.equal([0, 1, 255]);

    const records = store.snapshot();
    expect([...records.keys()].some((key) => key.startsWith('fs:'))).to.equal(false);
    expect(records.has('v2:entry:docs/text.md')).to.equal(true);
    expect(records.has('v2:entry:asset.bin')).to.equal(true);
    expect(records.get('v2:state')).to.deep.include({ migrationVersion: 2 });
    await provider.dispose();
  });

  it('keeps legacy conditional commits on the v2 authority after namespace cutover', async () => {
    const store = new FakeTransactionalStore();
    seedLegacyText(store, 'note.md', 'before');
    const legacy = new IndexedDBFileSystemProvider('migrated-legacy-commit', 'Shared', {
      store,
      now: () => new Date('2026-07-11T12:00:00.000Z'),
    });

    expect(decode((await legacy.v2.readFile(p('/note.md')))?.data)).to.equal('before');
    expect(await legacy.commitFile('/note.md', 'after', 'before')).to.deep.include({
      status: 'committed',
    });
    expect(decode((await legacy.v2.readFile(p('/note.md')))?.data)).to.equal('after');

    await legacy.dispose();
  });

  it('migrates byte-identical dual payloads without inventing an authority conflict', async () => {
    const store = new FakeTransactionalStore();
    seedLegacyText(store, 'same.md', 'same bytes');
    store.seed('fs:same.md:binary', encode('same bytes').buffer);
    const { provider } = createProvider(store);

    expect(decode((await provider.readFile(p('/same.md')))?.data)).to.equal('same bytes');
    expect(await provider.listLegacyMigrationConflicts()).to.deep.equal([]);

    await provider.dispose();
  });

  it('never chooses between dual legacy payloads and exposes explicit recovery', async () => {
    const store = new FakeTransactionalStore();
    seedLegacyText(store, 'ambiguous.md', 'text authority');
    store.seed('fs:ambiguous.md:binary', encode('binary authority').buffer);
    const { provider } = createProvider(store);

    expect(await provider.readFile(p('/ambiguous.md'))).to.equal(null);
    const conflicts = await provider.listLegacyMigrationConflicts();
    expect(conflicts).to.have.length(1);
    expect(conflicts[0]?.reason).to.equal('dual-payload');
    expect(conflicts[0]?.text).to.equal('text authority');
    expect(decode(conflicts[0]?.binary ?? undefined)).to.equal('binary authority');

    await provider.resolveLegacyMigrationConflict(p('/ambiguous.md'), 'text');
    expect(decode((await provider.readFile(p('/ambiguous.md')))?.data)).to.equal('text authority');
    expect(await provider.listLegacyMigrationConflicts()).to.deep.equal([]);
    expect(store.snapshot().has('fs:ambiguous.md:content')).to.equal(false);
    await provider.dispose();
  });

  it('rolls back the entire first-open migration when any record write fails', async () => {
    const store = new FakeTransactionalStore();
    seedLegacyText(store, 'note.md', 'safe');
    const before = store.snapshot();
    const { provider } = createProvider(store);
    store.failNext('put', 'v2:state');

    await expectFsError(provider.snapshot(), 'io');
    expect([...store.snapshot().entries()]).to.deep.equal([...before.entries()]);

    expect(decode((await provider.readFile(p('/note.md')))?.data)).to.equal('safe');
    await provider.dispose();
  });

  it('rolls back v2 authority on a write fault', async () => {
    const { provider, store } = createProvider();
    await provider.snapshot();
    const before = store.snapshot();
    store.failNext('put', 'v2:state');

    await expectFsError(provider.writeFile(p('/new.md'), encode('new')), 'io');
    expect([...store.snapshot().entries()]).to.deep.equal([...before.entries()]);
    expect(await provider.stat(p('/new.md'))).to.equal(null);
    await provider.dispose();
  });

  it('quarantines a stale-client branch without blocking unrelated reads', async () => {
    const { provider, store } = createProvider();
    const path = p('/note.md');
    await provider.writeFile(path, encode('authority'));
    await provider.writeFile(p('/other.md'), encode('unrelated'));
    store.seed('fs:note.md:binary', encode('stale branch').buffer);
    store.seed('fs:note.md:meta', legacyMetadata('note.md', encode('stale branch').byteLength));

    expect(decode((await provider.readFile(p('/other.md')))?.data)).to.equal('unrelated');
    expect(decode((await provider.readFile(path))?.data)).to.equal('authority');
    const conflicts = await provider.listLegacyMigrationConflicts();
    expect(conflicts).to.have.length(1);
    expect(conflicts[0]).to.deep.include({ path, reason: 'stale-client-write' });
    expect(decode(conflicts[0]?.binary ?? undefined)).to.equal('stale branch');
    expect([...store.snapshot().keys()].some((key) => key.startsWith('fs:'))).to.equal(false);

    await provider.resolveLegacyMigrationConflict(path, 'binary');
    expect(decode((await provider.readFile(path))?.data)).to.equal('stale branch');
    await provider.dispose();
  });

  it('commits quarantine before rejecting a same-path mutation', async () => {
    const { provider, store } = createProvider();
    const path = p('/note.md');
    await provider.writeFile(path, encode('authority'));
    seedLegacyText(store, 'note.md', 'stale branch');

    await expectFsError(provider.writeFile(path, encode('replacement')), 'conflict');
    expect(decode((await provider.readFile(path))?.data)).to.equal('authority');
    expect((await provider.listLegacyMigrationConflicts())[0]?.text).to.equal('stale branch');
    expect([...store.snapshot().keys()].some((key) => key.startsWith('fs:'))).to.equal(false);

    await provider.dispose();
  });

  it('rolls back stale-client quarantine when namespace deletion fails', async () => {
    const { provider, store } = createProvider();
    await provider.writeFile(p('/note.md'), encode('authority'));
    seedLegacyText(store, 'note.md', 'stale branch');
    const before = store.snapshot();
    store.failNext('delete', 'fs:note.md:content');

    await expectFsError(provider.readFile(p('/other.md')), 'io');
    expect([...store.snapshot().entries()]).to.deep.equal([...before.entries()]);

    await provider.readFile(p('/other.md'));
    expect((await provider.listLegacyMigrationConflicts())[0]?.text).to.equal('stale branch');
    await provider.dispose();
  });

  it('retains repeated stale-client branches as independently selectable candidates', async () => {
    const { provider, store } = createProvider();
    const path = p('/note.md');
    await provider.writeFile(path, encode('authority'));

    seedLegacyText(store, 'note.md', 'stale one');
    await provider.readFile(p('/other.md'));
    seedLegacyText(store, 'note.md', 'stale two');
    await provider.readFile(p('/other.md'));

    const conflict = (await provider.listLegacyMigrationConflicts())[0]!;
    expect(conflict.candidates.map((candidate) => candidate.text)).to.deep.equal([
      'stale one',
      'stale two',
    ]);
    await provider.resolveLegacyMigrationConflict(path, { candidate: 0, payload: 'text' });
    expect(decode((await provider.readFile(path))?.data)).to.equal('stale one');

    await provider.dispose();
  });

  it('can explicitly restore a quarantined stale-client directory', async () => {
    const { provider, store } = createProvider();
    await provider.snapshot();
    store.seed('fs:dirs', ['restored']);

    await provider.readFile(p('/other.md'));
    const conflict = (await provider.listLegacyMigrationConflicts())[0]!;
    expect(conflict).to.deep.include({ path: 'restored', kind: 'directory' });

    await provider.resolveLegacyMigrationConflict(p('/restored'), {
      candidate: 0,
      payload: 'directory',
    });
    expect(await provider.stat(p('/restored'))).to.deep.include({ kind: 'directory' });
    await provider.dispose();
  });

  it('upgrades migrationVersion 1 and preserves divergent v2 and legacy branches', async () => {
    const store = new FakeTransactionalStore();
    seedV1Authority(store, 'note.md', 'v2 authority');
    seedLegacyBinary(store, 'note.md', encode('legacy branch'));
    const { provider } = createProvider(store);

    expect(decode((await provider.readFile(p('/note.md')))?.data)).to.equal('v2 authority');
    const conflicts = await provider.listLegacyMigrationConflicts();
    expect(conflicts).to.have.length(1);
    expect(conflicts[0]).to.deep.include({ reason: 'authority-collision' });
    expect(decode(conflicts[0]?.binary ?? undefined)).to.equal('legacy branch');
    expect(store.snapshot().get('v2:state')).to.deep.include({ migrationVersion: 2 });
    expect([...store.snapshot().keys()].some((key) => key.startsWith('fs:'))).to.equal(false);

    await provider.resolveLegacyMigrationConflict(p('/note.md'), 'v2');
    expect(decode((await provider.readFile(p('/note.md')))?.data)).to.equal('v2 authority');
    await provider.dispose();
  });

  it('rolls back a migrationVersion 1 namespace cutover when legacy deletion fails', async () => {
    const store = new FakeTransactionalStore();
    seedV1Authority(store, 'note.md', 'authority');
    seedLegacyBinary(store, 'note.md', encode('authority'));
    const before = store.snapshot();
    const { provider } = createProvider(store);
    store.failNext('delete', 'fs:note.md:binary');

    await expectFsError(provider.snapshot(), 'io');
    expect([...store.snapshot().entries()]).to.deep.equal([...before.entries()]);

    expect(decode((await provider.readFile(p('/note.md')))?.data)).to.equal('authority');
    await provider.dispose();
  });

  it('uses a namespace probe instead of enumerating the workspace on ordinary reads', async () => {
    const { provider, store } = createProvider();
    await provider.writeFile(p('/note.md'), encode('authority'));
    store.resetOperationCounts();

    expect(decode((await provider.readFile(p('/note.md')))?.data)).to.equal('authority');
    expect(store.prefixProbeCalls).to.equal(1);
    expect(store.keysCalls).to.equal(0);

    await provider.dispose();
  });

  it('lets an accepted transaction finish before disposal closes the store', async () => {
    const { provider, store } = createProvider();
    await provider.snapshot();
    const gate = deferred<void>();
    store.pauseNextWriteUntil(gate.promise);

    const write = provider.writeFile(p('/closing.md'), encode('durable'));
    await waitForActiveWrite(store);
    const closing = provider.dispose();
    expect(store.closeCalls).to.equal(0);
    await expectFsError(provider.snapshot(), 'disposed');

    gate.resolve(undefined);
    await write;
    await closing;
    await provider.dispose();

    expect(store.closeCalls).to.equal(1);
    expect(store.snapshot().has('v2:entry:closing.md')).to.equal(true);
  });

  it('exposes a legacy facade that writes only the shared v2 authority', async () => {
    const store = new FakeTransactionalStore();
    const legacy = new IndexedDBFileSystemProvider('shared-v1-v2', 'Shared', {
      store,
      now: () => new Date('2026-07-11T12:00:00.000Z'),
    });
    const path = p('/note.md');
    await legacy.v2.writeFile(path, encode('revisioned'));

    expect(await legacy.readFile('/note.md')).to.equal('revisioned');
    await legacy.writeFile('/note.md', 'legacy bridge');
    expect(decode((await legacy.v2.readFile(path))?.data)).to.equal('legacy bridge');

    await legacy.createDirectory('/folder');
    await legacy.writeBinary('/folder/data.bin', new Uint8Array([1, 2, 3]));
    await legacy.rename('/folder', '/moved');
    expect(bytes((await legacy.v2.readFile(p('/moved/data.bin')))?.data)).to.deep.equal([1, 2, 3]);
    expect(await legacy.v2.stat(p('/folder'))).to.equal(null);
    await legacy.delete('/moved');
    expect(await legacy.v2.stat(p('/moved'))).to.equal(null);
    expect([...store.snapshot().keys()].some((key) => key.startsWith('fs:'))).to.equal(false);

    await legacy.dispose();
    expect(store.closeCalls).to.equal(1);
    await expectFsError(legacy.v2.snapshot(), 'disposed');
  });
});

function seedLegacyText(store: FakeTransactionalStore, path: string, content: string): void {
  store.seed(`fs:${path}:content`, content);
  store.seed(`fs:${path}:meta`, legacyMetadata(path, encode(content).byteLength));
}

function seedLegacyBinary(store: FakeTransactionalStore, path: string, content: Uint8Array): void {
  store.seed(`fs:${path}:binary`, content.buffer);
  store.seed(`fs:${path}:meta`, legacyMetadata(path, content.byteLength));
}

function seedV1Authority(store: FakeTransactionalStore, path: string, content: string): void {
  const version = 'idb-v1:1';
  const lastModified = '2026-07-10T12:00:00.000Z';
  store.seed('v2:state', {
    schemaVersion: 1,
    migrationVersion: 1,
    mutationCounter: 1,
    treeVersion: version,
  });
  store.seed('v2:entry:', {
    schemaVersion: 1,
    kind: 'directory',
    path: '',
    version,
    lastModified,
  });
  store.seed(`v2:entry:${path}`, {
    schemaVersion: 1,
    kind: 'file',
    path,
    data: encode(content).buffer,
    version,
    lastModified,
  });
  store.seed('fs:dirs', []);
}

function legacyMetadata(path: string, size: number) {
  const segments = path.split('/');
  return {
    name: segments.at(-1) ?? path,
    path,
    size,
    lastModified: '2026-07-10T12:00:00.000Z',
  };
}

function p(path: string) {
  return parseWorkspacePath(path);
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(value: ArrayBuffer | undefined): string | null {
  return value ? new TextDecoder().decode(value) : null;
}

function bytes(value: unknown): number[] | null {
  if (value instanceof ArrayBuffer) return [...new Uint8Array(value)];
  if (value instanceof Uint8Array) return [...value];
  return null;
}
