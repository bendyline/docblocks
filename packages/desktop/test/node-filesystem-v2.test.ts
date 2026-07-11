import { expect } from 'chai';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FsError,
  parseWorkspacePath,
  type FileSystemWatchEvent,
} from '@bendyline/docblocks/filesystem';
import { defineFileSystemProviderV2Conformance } from '../../core/test/helpers/filesystem-v2-conformance.js';
import { NodeWorkspaceFileSystemV2 } from '../main/node-workspace-filesystem-v2.js';
import { getWorkspaceRoots } from '../main/workspace-roots.js';
import type { WorkspaceWatcherEvent, WorkspaceWatcherHandle } from '../main/workspace-watchers.js';

const roots = getWorkspaceRoots();
const temporaryRoots: Array<{ id: string; path: string }> = [];
let providerSequence = 0;

class ControlledWatcher {
  private readonly eventListeners = new Set<
    (event: WorkspaceWatcherEvent) => void | Promise<void>
  >();
  private readonly errorListeners = new Set<(error: unknown) => void>();
  private readonly changeListeners = new Set<(path: string) => void>();

  public readonly handle: WorkspaceWatcherHandle;

  public constructor(
    ready: Promise<void> = Promise.resolve(),
    dispose: () => Promise<void> = async () => undefined,
  ) {
    this.handle = {
      ready,
      onChange: (listener) => addListener(this.changeListeners, listener),
      onEvent: (listener) => addListener(this.eventListeners, listener),
      onError: (listener) => addListener(this.errorListeners, listener),
      release: () => {
        void dispose();
      },
      dispose,
    };
  }

  public async emit(event: WorkspaceWatcherEvent): Promise<void> {
    for (const listener of [...this.changeListeners]) listener(event.path);
    await Promise.all([...this.eventListeners].map((listener) => listener(event)));
  }

  public get eventListenerCount(): number {
    return this.eventListeners.size;
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function addListener<T, R>(listeners: Set<(value: T) => R>, listener: (value: T) => R) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

defineFileSystemProviderV2Conformance('Node workspace', async () => {
  providerSequence += 1;
  const id = `node-v2-${providerSequence}`;
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-node-v2-'));
  temporaryRoots.push({ id, path: rootPath });
  roots.register(id, rootPath);
  const provider = new NodeWorkspaceFileSystemV2(id, 'Node v2', rootPath, roots);
  await provider.initialize();
  return provider;
});

after(async () => {
  for (const item of temporaryRoots) {
    roots.unregister(item.id);
    await fs.rm(item.path, { recursive: true, force: true });
  }
});

describe('NodeWorkspaceFileSystemV2 native boundary', () => {
  it('removes an empty directory without requiring recursive mode', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-node-v2-empty-'));
    const id = `node-v2-empty-${++providerSequence}`;
    roots.register(id, rootPath);
    const provider = new NodeWorkspaceFileSystemV2(id, 'Empty directory test', rootPath, roots);
    try {
      await provider.initialize();
      const empty = parseWorkspacePath('/empty');
      await provider.createDirectory(empty);
      expect((await provider.remove(empty)).removed).to.equal(true);
      expect(await provider.stat(empty)).to.equal(null);
    } finally {
      await provider.dispose();
      roots.unregister(id);
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  it('returns a typed path-escape error for a symlink or junction ancestor', async () => {
    const container = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-node-v2-link-'));
    const rootPath = path.join(container, 'workspace');
    const outside = path.join(container, 'outside');
    const id = `node-v2-link-${++providerSequence}`;
    await fs.mkdir(rootPath);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.md'), 'outside');
    await fs.symlink(
      outside,
      path.join(rootPath, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    roots.register(id, rootPath);
    const provider = new NodeWorkspaceFileSystemV2(id, 'Link test', rootPath, roots);
    try {
      await provider.initialize();
      let failure: unknown;
      try {
        await provider.readFile(parseWorkspacePath('/escape/secret.md'));
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(FsError);
      expect((failure as FsError).code).to.equal('path-escape');
      expect((failure as FsError).operation).to.equal('read');
    } finally {
      await provider.dispose();
      roots.unregister(id);
      await fs.rm(container, { recursive: true, force: true });
    }
  });

  it('does not open file payloads for stat or directory listing', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-node-v2-metadata-'));
    const id = `node-v2-metadata-${++providerSequence}`;
    await fs.mkdir(path.join(rootPath, 'nested'));
    await fs.writeFile(path.join(rootPath, 'note.md'), 'note');
    await fs.writeFile(path.join(rootPath, 'nested', 'child.md'), 'child');
    roots.register(id, rootPath);
    let payloadOpens = 0;
    const provider = new NodeWorkspaceFileSystemV2(id, 'Metadata scan', rootPath, roots, {
      openReadableFile: async (absolutePath) => {
        payloadOpens += 1;
        const handle = await fs.open(absolutePath, 'r');
        return {
          stat: () => handle.stat({ bigint: true }),
          readFile: () => handle.readFile(),
          close: () => handle.close(),
        };
      },
    });
    try {
      await provider.initialize();
      await provider.stat(parseWorkspacePath('/'));
      await provider.stat(parseWorkspacePath('/nested'));
      await provider.readDirectory(parseWorkspacePath('/'));
      expect(payloadOpens).to.equal(0);

      await provider.readFile(parseWorkspacePath('/note.md'));
      expect(payloadOpens).to.equal(1);

      await provider.snapshot();
      expect(payloadOpens).to.equal(3);
    } finally {
      await provider.dispose();
      roots.unregister(id);
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  it('uses the same stable metadata version for stat, read, and snapshot', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-node-v2-version-'));
    const id = `node-v2-version-${++providerSequence}`;
    const absolutePath = path.join(rootPath, 'note.md');
    await fs.writeFile(absolutePath, 'one');
    const fixedModifiedTime = new Date('2020-01-02T03:04:05.000Z');
    await fs.utimes(absolutePath, fixedModifiedTime, fixedModifiedTime);
    const originalNativeStat = await fs.stat(absolutePath);
    roots.register(id, rootPath);
    const provider = new NodeWorkspaceFileSystemV2(id, 'Metadata version', rootPath, roots);
    try {
      await provider.initialize();
      const itemPath = parseWorkspacePath('/note.md');
      const stat = await provider.stat(itemPath);
      const read = await provider.readFile(itemPath);
      const snapshotEntry = (await provider.snapshot()).entries.find(
        (entry) => entry.path === itemPath,
      );
      expect(read?.entry.version).to.equal(stat?.version);
      expect(snapshotEntry?.version).to.equal(stat?.version);

      await fs.writeFile(absolutePath, 'two');
      await fs.utimes(absolutePath, originalNativeStat.atime, originalNativeStat.mtime);
      const changed = await provider.stat(itemPath);
      expect(changed?.lastModified).to.equal(stat?.lastModified);
      expect(changed?.version).not.to.equal(stat?.version);
    } finally {
      await provider.dispose();
      roots.unregister(id);
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  it('retries a descriptor read when metadata changes before publication', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-node-v2-read-race-'));
    const id = `node-v2-read-race-${++providerSequence}`;
    const absolutePath = path.join(rootPath, 'note.md');
    await fs.writeFile(absolutePath, 'first');
    roots.register(id, rootPath);
    let attempts = 0;
    const provider = new NodeWorkspaceFileSystemV2(id, 'Read race', rootPath, roots, {
      openReadableFile: async (targetPath) => {
        attempts += 1;
        const attempt = attempts;
        const handle = await fs.open(targetPath, 'r+');
        let statCalls = 0;
        return {
          stat: async () => {
            statCalls += 1;
            if (attempt === 1 && statCalls === 2) {
              const replacement = Buffer.from('second');
              await handle.truncate(0);
              await handle.write(replacement, 0, replacement.byteLength, 0);
              await handle.sync();
            }
            return handle.stat({ bigint: true });
          },
          readFile: () => handle.readFile(),
          close: () => handle.close(),
        };
      },
    });
    try {
      await provider.initialize();
      const itemPath = parseWorkspacePath('/note.md');
      const read = await provider.readFile(itemPath);
      expect(new TextDecoder().decode(read?.data)).to.equal('second');
      expect(attempts).to.equal(2);
      expect(read?.entry.version).to.equal((await provider.stat(itemPath))?.version);
    } finally {
      await provider.dispose();
      roots.unregister(id);
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });
});

describe('NodeWorkspaceFileSystemV2 watch hardening', () => {
  it('opens a fresh watch session when subscribing during last-unsubscribe teardown', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-node-v2-watch-race-'));
    const id = `node-v2-watch-race-${++providerSequence}`;
    const firstClose = deferred();
    const secondAcquired = deferred();
    const secondReady = deferred();
    const controls: ControlledWatcher[] = [];
    roots.register(id, rootPath);
    const provider = new NodeWorkspaceFileSystemV2(id, 'Watch race', rootPath, roots, {
      acquireWatcher: () => {
        const index = controls.length;
        const control = new ControlledWatcher(
          index === 0 ? Promise.resolve() : secondReady.promise,
          index === 0 ? () => firstClose.promise : async () => undefined,
        );
        controls.push(control);
        if (index === 1) secondAcquired.resolve();
        return control.handle;
      },
    });

    try {
      await provider.initialize();
      const first = provider.watch(() => undefined);
      await first.ready;
      expect(controls).to.have.length(1);

      const closing = first.dispose();
      const second = provider.watch(() => undefined);
      let secondReadyResolved = false;
      void second.ready.then(() => {
        secondReadyResolved = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(controls).to.have.length(1);
      expect(secondReadyResolved).to.equal(false);

      firstClose.resolve();
      await closing;
      await secondAcquired.promise;
      expect(controls).to.have.length(2);
      expect(secondReadyResolved).to.equal(false);

      secondReady.resolve();
      await second.ready;
      expect(secondReadyResolved).to.equal(true);
      await second.dispose();
    } finally {
      await provider.dispose();
      roots.unregister(id);
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  it('does not suppress a genuine external same-path edit after a local write', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-node-v2-watch-edit-'));
    const id = `node-v2-watch-edit-${++providerSequence}`;
    const control = new ControlledWatcher();
    roots.register(id, rootPath);
    const provider = new NodeWorkspaceFileSystemV2(id, 'Watch edit', rootPath, roots, {
      acquireWatcher: () => control.handle,
    });
    const events: FileSystemWatchEvent[] = [];
    const errors: FsError[] = [];

    try {
      await provider.initialize();
      const subscription = provider.watch((event) => events.push(event), {
        onError: (error) => errors.push(error),
      });
      await subscription.ready;
      expect(control.eventListenerCount).to.equal(1);
      const note = parseWorkspacePath('/note.md');
      await provider.writeFile(note, new TextEncoder().encode('local'));
      const localVersion = (await provider.stat(note))?.version;

      await fs.writeFile(path.join(rootPath, 'note.md'), 'external');
      await control.emit({ type: 'modified', kind: 'file', path: '/note.md' });
      expect(errors).to.deep.equal([]);
      const external = events.findLast((event) => event.origin === 'external');
      expect(external?.type).to.equal('modified');
      expect(external?.version).not.to.equal(localVersion);
      expect(new TextDecoder().decode((await provider.readFile(note))?.data)).to.equal('external');
      await subscription.dispose();
    } finally {
      await provider.dispose();
      roots.unregister(id);
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  it('emits overflow when a locally removed path is externally recreated before its echo', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-node-v2-watch-recreate-'));
    const id = `node-v2-watch-recreate-${++providerSequence}`;
    const control = new ControlledWatcher();
    roots.register(id, rootPath);
    const provider = new NodeWorkspaceFileSystemV2(id, 'Watch recreate', rootPath, roots, {
      acquireWatcher: () => control.handle,
    });
    const events: FileSystemWatchEvent[] = [];
    const errors: FsError[] = [];

    try {
      await provider.initialize();
      const subscription = provider.watch((event) => events.push(event), {
        onError: (error) => errors.push(error),
      });
      await subscription.ready;
      expect(control.eventListenerCount).to.equal(1);
      const note = parseWorkspacePath('/note.md');
      await provider.writeFile(note, new TextEncoder().encode('initial'));
      await provider.remove(note);
      events.splice(0);

      await fs.writeFile(path.join(rootPath, 'note.md'), 'recreated');
      await control.emit({ type: 'removed', kind: 'file', path: '/note.md' });
      expect(errors).to.deep.equal([]);
      expect(
        events.some((event) => event.origin === 'external' && event.type === 'overflow'),
      ).to.equal(true);
      expect(new TextDecoder().decode((await provider.readFile(note))?.data)).to.equal('recreated');
      await subscription.dispose();
    } finally {
      await provider.dispose();
      roots.unregister(id);
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });
});
