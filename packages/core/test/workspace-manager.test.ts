import { expect } from 'chai';
import type {
  IndexedDBFileSystemStore,
  IndexedDBFileSystemTransaction,
  IndexedDBFileSystemTransactionMode,
} from '../src/filesystem/indexeddb-store.js';
import { MemoryFileSystemProvider } from '../src/filesystem/memory-provider.js';
import {
  ensureDefaultWorkspace,
  getTransientWorkspace,
  getWorkspace,
  listWorkspaces,
  registerTransientWorkspace,
  removeWorkspace,
  saveWorkspace,
  setWorkspaceRegistryStore,
  touchWorkspace,
  unregisterTransientWorkspace,
} from '../src/workspace/workspace-manager.js';
import type { WorkspaceDescriptor } from '../src/workspace/types.js';

const LIST_KEY = 'workspace-list';

/**
 * In-memory stand-in for the registry's IndexedDB store. Clones on read and
 * write (as structured cloning does), and only commits a readwrite transaction
 * that ran to completion, so an aborted transaction leaves the prior value —
 * the property the registry depends on.
 */
class MemoryRegistryStore implements IndexedDBFileSystemStore {
  private entries = new Map<string, unknown>();
  /** When set, the next `get` rejects, standing in for a transient IDB failure. */
  public failNextRead = false;

  public async transaction<T>(
    mode: IndexedDBFileSystemTransactionMode,
    operation: (transaction: IndexedDBFileSystemTransaction) => Promise<T>,
  ): Promise<T> {
    const staged = new Map(this.entries);
    const failRead = (): boolean => {
      if (!this.failNextRead) return false;
      this.failNextRead = false;
      return true;
    };

    const transaction: IndexedDBFileSystemTransaction = {
      get: async <V>(key: string): Promise<V | null> => {
        if (failRead()) throw new Error('IndexedDB read failed.');
        const value = staged.get(key);
        return value === undefined ? null : (structuredClone(value) as V);
      },
      put: async <V>(key: string, value: V): Promise<void> => {
        staged.set(key, structuredClone(value));
      },
      delete: async (key: string): Promise<void> => {
        staged.delete(key);
      },
      keys: async (): Promise<string[]> => [...staged.keys()],
      hasKeyWithPrefix: async (prefix: string): Promise<boolean> =>
        [...staged.keys()].some((key) => key.startsWith(prefix)),
    };

    const result = await operation(transaction);
    if (mode === 'readwrite') this.entries = staged;
    return result;
  }

  public reset(): void {
    this.entries = new Map();
    this.failNextRead = false;
  }

  public peek(key: string): unknown {
    const value = this.entries.get(key);
    return value === undefined ? null : structuredClone(value);
  }

  public seed(key: string, value: unknown): void {
    this.entries.set(key, structuredClone(value));
  }
}

const storage = new MemoryRegistryStore();

const transientIds = ['transient-a', 'transient-replacement'];

function descriptor(id: string, name = id): WorkspaceDescriptor {
  return {
    id,
    name,
    type: 'indexeddb',
    lastOpened: '2026-01-01T00:00:00.000Z',
  };
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error: unknown) {
    return error;
  }
}

async function listedIds(): Promise<string[]> {
  return (await listWorkspaces()).map((workspace) => workspace.id).sort();
}

describe('workspace manager', () => {
  beforeEach(async () => {
    await Promise.all(transientIds.map((id) => unregisterTransientWorkspace(id)));
    storage.reset();
    setWorkspaceRegistryStore(storage);
  });

  afterEach(async () => {
    await Promise.all(transientIds.map((id) => unregisterTransientWorkspace(id)));
    storage.reset();
    setWorkspaceRegistryStore(null);
  });

  it('serializes concurrent saves without losing descriptors', async () => {
    const workspaces = Array.from({ length: 12 }, (_, index) => descriptor(`workspace-${index}`));

    await Promise.all(workspaces.map((workspace) => saveWorkspace(workspace)));

    expect(await listedIds()).to.deep.equal(workspaces.map((workspace) => workspace.id).sort());
  });

  it('updates, touches, retrieves, and removes one durable descriptor', async () => {
    await saveWorkspace(descriptor('durable', 'Initial'));
    await saveWorkspace({ ...descriptor('durable', 'Updated'), versioningOverride: 'on' });
    await touchWorkspace('durable');

    const updated = await getWorkspace('durable');
    expect(updated).to.include({ id: 'durable', name: 'Updated', versioningOverride: 'on' });
    expect(updated?.lastOpened).not.to.equal('2026-01-01T00:00:00.000Z');

    await removeWorkspace('durable');
    expect(await getWorkspace('durable')).to.equal(null);
  });

  it('creates one default workspace under concurrent startup calls', async () => {
    const defaults = await Promise.all([
      ensureDefaultWorkspace(),
      ensureDefaultWorkspace(),
      ensureDefaultWorkspace(),
    ]);

    expect(defaults.every((workspace) => workspace.id === 'default')).to.equal(true);
    expect(
      (await listWorkspaces()).filter((workspace) => workspace.id === 'default'),
    ).to.have.length(1);
  });

  it('keeps transient workspaces session-only and disposes replaced providers', async () => {
    const first = new MemoryFileSystemProvider('transient-first', 'First');
    const second = new MemoryFileSystemProvider('transient-second', 'Second');
    const transient: WorkspaceDescriptor = {
      id: 'transient-replacement',
      name: 'Transient',
      type: 'transient',
      lastOpened: '2026-01-01T00:00:00.000Z',
    };

    registerTransientWorkspace(transient, first);
    registerTransientWorkspace({ ...transient, name: 'Replacement' }, second);
    await Promise.resolve();

    expect(getTransientWorkspace(transient.id)?.provider).to.equal(second);
    expect(
      (await listWorkspaces()).find((workspace) => workspace.id === transient.id)?.name,
    ).to.equal('Replacement');
    expect(storage.peek(LIST_KEY)).to.equal(null);
    expect(await captureFailure(first.readDirectory('/'))).to.be.instanceOf(Error);

    await unregisterTransientWorkspace(transient.id);
    expect(getTransientWorkspace(transient.id)).to.equal(null);
    expect(await captureFailure(second.readDirectory('/'))).to.be.instanceOf(Error);
  });

  it('rejects corrupt persisted data instead of treating it as an empty registry', async () => {
    storage.seed(LIST_KEY, [
      {
        id: 'corrupt',
        name: 'Corrupt',
        type: 'transient',
        lastOpened: '2026-01-01T00:00:00.000Z',
      },
    ]);

    expect(await captureFailure(listWorkspaces())).to.be.instanceOf(Error);
  });

  it('surfaces an unreadable registry instead of reporting it as empty', async () => {
    await saveWorkspace(descriptor('durable'));

    storage.failNextRead = true;

    expect(await captureFailure(listWorkspaces())).to.be.instanceOf(Error);
  });

  it('never rewrites the registry from a read that failed', async () => {
    await saveWorkspace(descriptor('keep-a'));
    await saveWorkspace(descriptor('keep-b'));

    storage.failNextRead = true;
    expect(await captureFailure(touchWorkspace('keep-a'))).to.be.instanceOf(Error);

    // The aborted mutation must not have persisted a registry rebuilt from a
    // phantom empty list; both workspaces survive.
    expect(await listedIds()).to.deep.equal(['keep-a', 'keep-b']);
    expect(storage.peek(LIST_KEY)).to.have.length(2);
  });

  it('does not resurrect the default workspace over an unreadable registry', async () => {
    await saveWorkspace(descriptor('keep'));

    storage.failNextRead = true;
    expect(await captureFailure(ensureDefaultWorkspace())).to.be.instanceOf(Error);

    expect(await listedIds()).to.deep.equal(['keep']);
  });
});
