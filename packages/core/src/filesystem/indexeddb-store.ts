/**
 * Minimal, error-propagating IndexedDB store used by the virtual filesystem.
 *
 * The previous Squisq LocalForage adapter intentionally converted failed
 * reads/enumerations/removals into null/empty/success. Those semantics are
 * unsuitable for filesystem mutations: an unavailable database must never be
 * interpreted as an absent file. This layer opens the old database and object
 * store directly so existing data can be migrated in one transaction.
 */

export type IndexedDBFileSystemTransactionMode = 'readonly' | 'readwrite';

export interface IndexedDBFileSystemTransaction {
  get<T>(key: string): Promise<T | null>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  /** O(log n) namespace probe in the concrete IndexedDB implementation. */
  hasKeyWithPrefix(prefix: string): Promise<boolean>;
}

export interface IndexedDBFileSystemStore {
  transaction<T>(
    mode: IndexedDBFileSystemTransactionMode,
    operation: (transaction: IndexedDBFileSystemTransaction) => Promise<T>,
  ): Promise<T>;
  close?(): void;
}

export class RawIndexedDBFileSystemStore implements IndexedDBFileSystemStore {
  private database: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;
  private closed = false;

  public constructor(
    private readonly databaseName: string,
    private readonly storeName: string,
  ) {}

  public async transaction<T>(
    mode: IndexedDBFileSystemTransactionMode,
    operation: (transaction: IndexedDBFileSystemTransaction) => Promise<T>,
  ): Promise<T> {
    const database = await this.getDatabase();
    const nativeTransaction = database.transaction(this.storeName, mode);
    const completion = waitForTransaction(nativeTransaction);
    const transaction = new RawIndexedDBFileSystemTransaction(
      nativeTransaction.objectStore(this.storeName),
    );

    let result: T;
    try {
      result = await operation(transaction);
    } catch (error: unknown) {
      try {
        nativeTransaction.abort();
      } catch {
        // The request failure may already have aborted the transaction.
      }
      await completion.catch(() => undefined);
      throw error;
    }

    await completion;
    return result;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database?.close();
    this.database = null;
    this.opening = null;
  }

  private getDatabase(): Promise<IDBDatabase> {
    if (this.closed) {
      return Promise.reject(new Error('The IndexedDB filesystem store is closed.'));
    }
    if (this.database) return Promise.resolve(this.database);
    if (this.opening) return this.opening;
    if (typeof indexedDB === 'undefined') {
      return Promise.reject(new Error('IndexedDB is not available in this environment.'));
    }

    this.opening = openDatabaseWithStore(this.databaseName, this.storeName)
      .then((database) => {
        if (this.closed) {
          database.close();
          throw new Error('The IndexedDB filesystem store is closed.');
        }
        this.database = database;
        this.opening = null;
        database.onversionchange = () => {
          database.close();
          if (this.database === database) this.database = null;
        };
        return database;
      })
      .catch((error: unknown) => {
        this.opening = null;
        throw error;
      });
    return this.opening;
  }
}

class RawIndexedDBFileSystemTransaction implements IndexedDBFileSystemTransaction {
  public constructor(private readonly store: IDBObjectStore) {}

  public async get<T>(key: string): Promise<T | null> {
    const value = await requestResult(this.store.get(key));
    return value === undefined ? null : (value as T);
  }

  public async put<T>(key: string, value: T): Promise<void> {
    await requestResult(this.store.put(value, key));
  }

  public async delete(key: string): Promise<void> {
    await requestResult(this.store.delete(key));
  }

  public async keys(): Promise<string[]> {
    const keys = await requestResult(this.store.getAllKeys());
    return keys.map((key) => {
      if (typeof key !== 'string') {
        throw new Error('The DocBlocks filesystem store contains a non-string key.');
      }
      return key;
    });
  }

  public async hasKeyWithPrefix(prefix: string): Promise<boolean> {
    const cursor = await requestResult(this.store.openKeyCursor(IDBKeyRange.lowerBound(prefix)));
    return cursor !== null && typeof cursor.key === 'string' && cursor.key.startsWith(prefix);
  }
}

async function openDatabaseWithStore(
  databaseName: string,
  storeName: string,
): Promise<IDBDatabase> {
  const database = await openDatabase(databaseName, undefined, (upgradeDatabase) => {
    if (!upgradeDatabase.objectStoreNames.contains(storeName)) {
      upgradeDatabase.createObjectStore(storeName);
    }
  });
  if (database.objectStoreNames.contains(storeName)) return database;

  const nextVersion = database.version + 1;
  database.close();
  return openDatabase(databaseName, nextVersion, (upgradeDatabase) => {
    if (!upgradeDatabase.objectStoreNames.contains(storeName)) {
      upgradeDatabase.createObjectStore(storeName);
    }
  });
}

function openDatabase(
  databaseName: string,
  version: number | undefined,
  upgrade: (database: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request =
      version === undefined ? indexedDB.open(databaseName) : indexedDB.open(databaseName, version);
    let settled = false;

    request.onupgradeneeded = () => upgrade(request.result);
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error(`Could not open IndexedDB database ${databaseName}.`));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error(`IndexedDB database ${databaseName} is blocked by another open page.`));
    };
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
  });
}
