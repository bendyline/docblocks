import { expect } from 'chai';
import { createFileSystemDocumentTarget, DocumentSession } from '../src/document/index.js';
import type {
  FileCommitResult,
  FileMeta,
  FileSystemEntry,
  FileSystemProvider,
} from '../src/filesystem/index.js';

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

interface CommitGate {
  started: Deferred;
  release: Deferred;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function normalize(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return normalized ? `/${normalized}` : '/';
}

class DelayedFileSystemProvider implements FileSystemProvider {
  public readonly id = 'delayed-provider';
  public readonly label = 'Delayed provider';
  public readonly operations: string[] = [];
  public commitAttempts = 0;
  public failuresRemaining = 0;

  private readonly files = new Map<string, string>();
  private nextCommitGate: CommitGate | null = null;

  public constructor(path: string, content: string) {
    this.files.set(normalize(path), content);
  }

  public delayNextCommit(): CommitGate {
    const gate = { started: deferred(), release: deferred() };
    this.nextCommitGate = gate;
    return gate;
  }

  public async readFile(path: string): Promise<string | null> {
    return this.files.get(normalize(path)) ?? null;
  }

  public async writeFile(path: string, content: string): Promise<void> {
    this.files.set(normalize(path), content);
  }

  public async commitFile(
    path: string,
    content: string,
    expectedContent: string | null,
  ): Promise<FileCommitResult> {
    const canonical = normalize(path);
    this.commitAttempts += 1;
    this.operations.push(`commit:start:${canonical}:${content}`);
    const gate = this.nextCommitGate;
    this.nextCommitGate = null;
    if (gate) {
      gate.started.resolve();
      await gate.release.promise;
    }
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      this.operations.push(`commit:fail:${canonical}:${content}`);
      throw new Error('injected transient failure');
    }
    const current = this.files.get(canonical) ?? null;
    if (current !== expectedContent && current !== content) {
      return { status: 'conflict', content: current, version: null };
    }
    this.files.set(canonical, content);
    this.operations.push(`commit:finish:${canonical}:${content}`);
    return { status: 'committed', version: String(this.commitAttempts) };
  }

  public async delete(path: string): Promise<void> {
    const canonical = normalize(path);
    this.operations.push(`delete:${canonical}`);
    this.files.delete(canonical);
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    const source = normalize(oldPath);
    const destination = normalize(newPath);
    const content = this.files.get(source);
    if (content === undefined) throw new Error('Source does not exist.');
    if (this.files.has(destination)) throw new Error('Destination already exists.');
    this.operations.push(`move:${source}:${destination}`);
    this.files.set(destination, content);
    this.files.delete(source);
  }

  public async readDirectory(): Promise<FileSystemEntry[]> {
    return [];
  }

  public async exists(path: string): Promise<boolean> {
    return this.files.has(normalize(path));
  }

  public async createDirectory(): Promise<void> {}

  public async stat(path: string): Promise<FileMeta | null> {
    const canonical = normalize(path);
    const content = this.files.get(canonical);
    if (content === undefined) return null;
    return {
      name: canonical.slice(canonical.lastIndexOf('/') + 1),
      path: canonical,
      size: content.length,
      lastModified: String(this.commitAttempts),
    };
  }

  public async readBinary(): Promise<ArrayBuffer | null> {
    return null;
  }

  public async writeBinary(): Promise<void> {}
}

function edit(session: DocumentSession, content: string): void {
  const snapshot = session.getSnapshot();
  if (!snapshot.targetKey) throw new Error('Test session has no target.');
  session.edit(content, {
    targetKey: snapshot.targetKey,
    generation: snapshot.generation,
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the test condition.');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('DocumentSession delayed-provider integration', () => {
  it('finishes the old-path commit before moving and never splits later content across a rename', async () => {
    const provider = new DelayedFileSystemProvider('/old.md', 'initial');
    const gate = provider.delayNextCommit();
    const session = new DocumentSession({ autoSaveDelayMs: 0 });
    await session.transitionTo(createFileSystemDocumentTarget(provider, '/old.md'), 'initial');

    edit(session, 'before rename');
    await gate.started.promise;
    const renaming = session.retarget(createFileSystemDocumentTarget(provider, '/new.md'), () =>
      provider.rename('/old.md', '/new.md'),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(provider.operations).not.to.include('move:/old.md:/new.md');
    gate.release.resolve();
    await renaming;

    edit(session, 'after rename');
    await session.flush('manual');

    expect(await provider.readFile('/old.md')).to.equal(null);
    expect(await provider.readFile('/new.md')).to.equal('after rename');
    expect(provider.operations).to.deep.equal([
      'commit:start:/old.md:before rename',
      'commit:finish:/old.md:before rename',
      'move:/old.md:/new.md',
      'commit:start:/new.md:after rename',
      'commit:finish:/new.md:after rename',
    ]);
    await session.cancel();
  });

  it('makes deletion final when a delayed autosave and a newer queued edit both exist', async () => {
    const provider = new DelayedFileSystemProvider('/delete.md', 'initial');
    const gate = provider.delayNextCommit();
    const session = new DocumentSession({ autoSaveDelayMs: 0 });
    await session.transitionTo(createFileSystemDocumentTarget(provider, '/delete.md'), 'initial');

    edit(session, 'in flight');
    await gate.started.promise;
    edit(session, 'must be cancelled');
    const deleting = session.delete(() => provider.delete('/delete.md'));
    gate.release.resolve();
    await deleting;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(await provider.readFile('/delete.md')).to.equal(null);
    expect(provider.operations).to.deep.equal([
      'commit:start:/delete.md:in flight',
      'commit:finish:/delete.md:in flight',
      'delete:/delete.md',
    ]);
    expect(session.getSnapshot().status).to.equal('closed');
  });

  it('cancels a scheduled failure retry before deleting so it cannot resurrect the file', async () => {
    const provider = new DelayedFileSystemProvider('/retry-delete.md', 'initial');
    provider.failuresRemaining = 1;
    const session = new DocumentSession({
      autoSaveDelayMs: 0,
      autoSaveRetryDelaysMs: [40],
    });
    await session.transitionTo(
      createFileSystemDocumentTarget(provider, '/retry-delete.md'),
      'initial',
    );

    edit(session, 'failed autosave');
    await waitUntil(() => session.getSnapshot().status === 'error');
    await session.delete(() => provider.delete('/retry-delete.md'));
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(provider.commitAttempts).to.equal(1);
    expect(await provider.readFile('/retry-delete.md')).to.equal(null);
    expect(provider.operations.at(-1)).to.equal('delete:/retry-delete.md');
  });

  it('retries transient autosave failures with a bounded policy and eventually acknowledges', async () => {
    const provider = new DelayedFileSystemProvider('/retry.md', 'initial');
    provider.failuresRemaining = 2;
    const session = new DocumentSession({
      autoSaveDelayMs: 0,
      autoSaveRetryDelaysMs: [0, 0, 0],
    });
    await session.transitionTo(createFileSystemDocumentTarget(provider, '/retry.md'), 'initial');

    edit(session, 'eventually durable');
    await waitUntil(() => session.getSnapshot().status === 'saved');

    expect(provider.commitAttempts).to.equal(3);
    expect(await provider.readFile('/retry.md')).to.equal('eventually durable');
    expect(session.getSnapshot().persistedRevision).to.equal(session.getSnapshot().revision);
    await session.cancel();
  });

  it('stops after the configured retry budget and leaves the failed revision dirty', async () => {
    const provider = new DelayedFileSystemProvider('/bounded.md', 'initial');
    provider.failuresRemaining = 10;
    const session = new DocumentSession({
      autoSaveDelayMs: 0,
      autoSaveRetryDelaysMs: [0, 0],
    });
    await session.transitionTo(createFileSystemDocumentTarget(provider, '/bounded.md'), 'initial');

    edit(session, 'still dirty');
    await waitUntil(() => provider.commitAttempts === 3);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(provider.commitAttempts).to.equal(3);
    expect(session.getSnapshot().status).to.equal('error');
    expect(session.getSnapshot().persistedRevision).to.be.lessThan(session.getSnapshot().revision);
    expect(await provider.readFile('/bounded.md')).to.equal('initial');
    await session.cancel();
  });
});
