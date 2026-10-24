import { expect } from 'chai';
import { RawIndexedDBFileSystemStore } from '../src/filesystem/indexeddb-store.js';

const STORE_NAME = 'files';

/** Just enough of IDBTransaction for the store: one store and a completion event. */
class FakeTransaction {
  public oncomplete: (() => void) | null = null;
  public onabort: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public readonly error = null;

  public constructor(private readonly records: Map<string, unknown>) {
    setTimeout(() => this.oncomplete?.(), 0);
  }

  public objectStore(): unknown {
    return {
      get: (key: string) => fakeRequest(this.records.get(key)),
    };
  }

  public abort(): void {}
}

class FakeDatabase {
  public onclose: (() => void) | null = null;
  public onversionchange: (() => void) | null = null;
  public readonly objectStoreNames = { contains: (name: string) => name === STORE_NAME };
  public readonly version = 1;
  private closePending = false;

  public constructor(private readonly records: Map<string, unknown>) {}

  public transaction(): FakeTransaction {
    if (this.closePending) {
      throw new DOMException(
        "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
        'InvalidStateError',
      );
    }
    return new FakeTransaction(this.records);
  }

  public close(): void {
    this.closePending = true;
  }

  /** The browser closing the connection on its own, with a `close` event. */
  public dropWithEvent(): void {
    this.closePending = true;
    this.onclose?.();
  }

  /** The browser closing the connection with no event reaching the page. */
  public dropSilently(): void {
    this.closePending = true;
  }
}

function fakeRequest<T>(result: T): { result: T; onsuccess: (() => void) | null } {
  const request: { result: T; onsuccess: (() => void) | null } = { result, onsuccess: null };
  setTimeout(() => request.onsuccess?.(), 0);
  return request;
}

function installFakeIndexedDB(records: Map<string, unknown>): {
  readonly connections: FakeDatabase[];
  restore(): void;
} {
  const connections: FakeDatabase[] = [];
  const factory = {
    open: () => {
      const request: {
        result: FakeDatabase | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onblocked: (() => void) | null;
        onupgradeneeded: (() => void) | null;
      } = { result: null, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      setTimeout(() => {
        const database = new FakeDatabase(records);
        connections.push(database);
        request.result = database;
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true });
  return {
    connections,
    restore() {
      if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor);
      else Reflect.deleteProperty(globalThis, 'indexedDB');
    },
  };
}

describe('RawIndexedDBFileSystemStore connection recovery', () => {
  let fake: ReturnType<typeof installFakeIndexedDB>;

  beforeEach(() => {
    fake = installFakeIndexedDB(new Map([['note.md', 'hello']]));
  });

  afterEach(() => {
    fake.restore();
  });

  const readNote = (store: RawIndexedDBFileSystemStore) =>
    store.transaction('readonly', (tx) => tx.get<string>('note.md'));

  it('reopens when the browser closed the cached connection without an event', async () => {
    const store = new RawIndexedDBFileSystemStore('docblocks-fs-test', STORE_NAME);
    expect(await readNote(store)).to.equal('hello');

    fake.connections[0]?.dropSilently();

    expect(await readNote(store)).to.equal('hello');
    expect(fake.connections).to.have.length(2);
  });

  it('drops the cached connection when the browser fires close', async () => {
    const store = new RawIndexedDBFileSystemStore('docblocks-fs-test', STORE_NAME);
    expect(await readNote(store)).to.equal('hello');

    fake.connections[0]?.dropWithEvent();

    expect(await readNote(store)).to.equal('hello');
    expect(fake.connections).to.have.length(2);
  });

  it('does not reopen a store its owner closed', async () => {
    const store = new RawIndexedDBFileSystemStore('docblocks-fs-test', STORE_NAME);
    expect(await readNote(store)).to.equal('hello');

    store.close();

    let failure: unknown = null;
    try {
      await readNote(store);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    expect((failure as Error).message).to.equal('The IndexedDB filesystem store is closed.');
    expect(fake.connections).to.have.length(1);
  });
});
