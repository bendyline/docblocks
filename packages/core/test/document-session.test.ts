import { expect } from 'chai';
import {
  createFileSystemDocumentTarget,
  DocumentSession,
  DocumentSessionConflictError,
  type DocumentCommitRequest,
  type DocumentCommitTarget,
} from '../src/document/index.js';
import { MemoryFileSystemProvider, parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import {
  FileSystemMoveRecoveryError,
  FileSystemPartialMoveError,
} from '../src/filesystem/move-error.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function target(
  key: string,
  commit: (request: DocumentCommitRequest) => Promise<void>,
): DocumentCommitTarget {
  return { key, commit };
}

async function nextTask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function edit(session: DocumentSession, content: string): number {
  const snapshot = session.getSnapshot();
  if (!snapshot.targetKey) throw new Error('Test session has no target.');
  return session.edit(content, {
    targetKey: snapshot.targetKey,
    generation: snapshot.generation,
  });
}

describe('DocumentSession', () => {
  it('coalesces rapid edits into the latest autosave revision', async () => {
    const commits: DocumentCommitRequest[] = [];
    const session = new DocumentSession({ autoSaveDelayMs: 5 });
    await session.transitionTo(
      target('workspace:a.md', async (request) => {
        commits.push(request);
      }),
      'initial',
    );

    edit(session, 'one');
    edit(session, 'two');
    edit(session, 'three');
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(commits.map((commit) => commit.content)).to.deep.equal(['three']);
    expect(session.getSnapshot().status).to.equal('saved');
    expect(session.getSnapshot().persistedRevision).to.equal(session.getSnapshot().revision);
  });

  it('can disable and re-enable autosave without weakening manual persistence', async () => {
    const committed: string[] = [];
    const session = new DocumentSession({ autoSaveDelayMs: 5, autoSaveEnabled: false });
    await session.transitionTo(
      target('workspace:a.md', async (request) => {
        committed.push(request.content);
      }),
      'initial',
    );

    edit(session, 'manual revision');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(committed).to.deep.equal([]);
    expect(session.getSnapshot().status).to.equal('dirty');

    await session.flush('manual');
    expect(committed).to.deep.equal(['manual revision']);

    edit(session, 'automatic revision');
    session.setAutoSaveEnabled(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(committed).to.deep.equal(['manual revision', 'automatic revision']);
    expect(session.getSnapshot().status).to.equal('saved');
  });

  it('serializes commits and follows an in-flight write with the latest revision', async () => {
    const firstCommit = deferred<void>();
    const committed: string[] = [];
    let active = 0;
    let maxActive = 0;
    const session = new DocumentSession({ autoSaveDelayMs: 1_000 });
    await session.transitionTo(
      target('workspace:a.md', async (request) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        committed.push(request.content);
        if (committed.length === 1) await firstCommit.promise;
        active -= 1;
      }),
      'initial',
    );

    edit(session, 'first');
    const flushing = session.flush();
    await nextTask();
    edit(session, 'latest');
    firstCommit.resolve();
    await flushing;

    expect(maxActive).to.equal(1);
    expect(committed).to.deep.equal(['first', 'latest']);
    expect(session.getSnapshot().persistedContent).to.equal('latest');
  });

  it('reports a failed flush honestly and retries on the next flush', async () => {
    let attempts = 0;
    const session = new DocumentSession({ autoSaveDelayMs: 1_000 });
    await session.transitionTo(
      target('workspace:a.md', async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('disk full');
      }),
      'initial',
    );
    edit(session, 'changed');

    let firstError: unknown;
    try {
      await session.flush();
    } catch (error) {
      firstError = error;
    }
    expect(firstError).to.be.instanceOf(Error);
    expect(session.getSnapshot().status).to.equal('error');
    expect(session.getSnapshot().persistedContent).to.equal('initial');

    await session.flush();
    expect(attempts).to.equal(2);
    expect(session.getSnapshot().status).to.equal('saved');
    expect(session.getSnapshot().persistedContent).to.equal('changed');
  });

  it('flushes, moves storage, and only then commits to the new target', async () => {
    const operations: string[] = [];
    const session = new DocumentSession({ autoSaveDelayMs: 1_000 });
    await session.transitionTo(
      target('workspace:old.md', async (request) => {
        operations.push('old:' + request.content);
      }),
      'initial',
    );
    edit(session, 'before move');

    await session.retarget(
      target('workspace:new.md', async (request) => {
        operations.push('new:' + request.content);
      }),
      async () => {
        operations.push('move');
      },
    );
    edit(session, 'after move');
    await session.flush();

    expect(operations).to.deep.equal(['old:before move', 'move', 'new:after move']);
    expect(session.getSnapshot().targetKey).to.equal('workspace:new.md');
  });

  it('retargets and freezes when a failed rollback leaves the document only at the destination', async () => {
    const session = new DocumentSession({ autoSaveDelayMs: 1_000 });
    await session.transitionTo(
      target('workspace:old.md', async () => undefined),
      'initial',
    );
    const partial = new FileSystemPartialMoveError(
      '/old.md',
      '/new.md',
      '/old_files',
      '/new_files',
      {
        source: 'missing',
        destination: 'present',
        companionSource: 'present',
        companionDestination: 'missing',
      },
      new Error('companion failed'),
      new Error('rollback failed'),
    );

    let failure: unknown;
    try {
      await session.retarget(
        target('workspace:new.md', async () => undefined),
        async () => {
          throw partial;
        },
      );
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).to.equal(partial);
    expect(session.getSnapshot().targetKey).to.equal('workspace:new.md');
    expect(session.getSnapshot().frozen).to.equal(true);
    expect(session.getSnapshot().status).to.equal('error');
    expect(() => edit(session, 'must not autosave')).to.throw('Cannot edit');
  });

  it('retargets and freezes when one backend move reaches the destination before failing', async () => {
    const session = new DocumentSession({ autoSaveDelayMs: 1_000 });
    await session.transitionTo(
      target('workspace:old.md', async () => undefined),
      'initial',
    );
    const recovery = new FileSystemMoveRecoveryError(
      '/old.md',
      '/new.md',
      { source: 'missing', destination: 'present' },
      new Error('move acknowledgement failed'),
    );

    let failure: unknown;
    try {
      await session.retarget(
        target('workspace:new.md', async () => undefined),
        async () => {
          throw recovery;
        },
      );
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).to.equal(recovery);
    expect(session.getSnapshot().targetKey).to.equal('workspace:new.md');
    expect(session.getSnapshot().frozen).to.equal(true);
    expect(session.getSnapshot().status).to.equal('error');
  });

  it('waits for an in-flight commit and makes deletion the final storage operation', async () => {
    const pending = deferred<void>();
    const operations: string[] = [];
    const session = new DocumentSession({ autoSaveDelayMs: 1_000 });
    await session.transitionTo(
      target('workspace:a.md', async () => {
        operations.push('commit');
        await pending.promise;
      }),
      'initial',
    );

    edit(session, 'changed');
    const flushing = session.flush();
    await nextTask();
    const deleting = session.delete(async () => {
      operations.push('delete');
    });
    pending.resolve();
    await Promise.allSettled([flushing, deleting]);

    expect(operations).to.deep.equal(['commit', 'delete']);
    expect(session.getSnapshot().status).to.equal('closed');
    expect(session.getSnapshot().targetKey).to.equal(null);
  });

  it('adopts clean external edits but protects dirty local content with a conflict', async () => {
    const commits: DocumentCommitRequest[] = [];
    const session = new DocumentSession({ autoSaveDelayMs: 1_000 });
    await session.transitionTo(
      target('workspace:a.md', async (request) => {
        commits.push(request);
      }),
      'initial',
    );

    expect(
      session.observeExternal({
        targetKey: 'workspace:a.md',
        content: 'external clean',
        version: 2,
      }),
    ).to.equal('applied');
    expect(session.getSnapshot().content).to.equal('external clean');

    edit(session, 'local draft');
    expect(
      session.observeExternal({
        targetKey: 'workspace:a.md',
        content: 'external conflict',
        version: 3,
      }),
    ).to.equal('conflict');
    expect(session.getSnapshot().status).to.equal('conflict');
    expect(session.getSnapshot().content).to.equal('local draft');

    let conflictError: unknown;
    try {
      await session.flush();
    } catch (error) {
      conflictError = error;
    }
    expect(conflictError).to.be.instanceOf(DocumentSessionConflictError);

    await session.resolveConflict('use-local');
    expect(commits.at(-1)?.content).to.equal('local draft');
    expect(commits.at(-1)?.persistedContent).to.equal('external conflict');
    expect(session.getSnapshot().status).to.equal('saved');
  });

  it('refreshes a conflict when the external branch returns to the persisted baseline', async () => {
    const session = new DocumentSession({ autoSaveDelayMs: 1_000 });
    await session.transitionTo(
      target('workspace:a.md', async () => undefined),
      'A',
    );

    edit(session, 'C');
    expect(
      session.observeExternal({
        targetKey: 'workspace:a.md',
        content: 'B',
        version: 2,
        sequence: 1,
      }),
    ).to.equal('conflict');
    expect(session.getSnapshot().conflict?.externalContent).to.equal('B');

    expect(
      session.observeExternal({
        targetKey: 'workspace:a.md',
        content: 'A',
        version: 3,
        sequence: 2,
      }),
    ).to.equal('conflict');
    expect(session.getSnapshot().conflict?.externalContent).to.equal('A');
    expect(session.getSnapshot().conflict?.externalVersion).to.equal(3);

    const reloaded = await session.resolveConflict('use-external');
    expect(reloaded.content).to.equal('A');
    expect(reloaded.persistedContent).to.equal('A');
    expect(reloaded.status).to.equal('saved');
  });

  it('acknowledges an external branch that converges to the latest local revision', async () => {
    const commits: DocumentCommitRequest[] = [];
    const session = new DocumentSession({ autoSaveDelayMs: 1_000 });
    await session.transitionTo(
      target('workspace:a.md', async (request) => {
        commits.push(request);
      }),
      'A',
    );

    edit(session, 'C');
    expect(
      session.observeExternal({
        targetKey: 'workspace:a.md',
        content: 'B',
        sequence: 1,
      }),
    ).to.equal('conflict');
    expect(
      session.observeExternal({
        targetKey: 'workspace:a.md',
        content: 'C',
        sequence: 2,
      }),
    ).to.equal('applied');

    const converged = session.getSnapshot();
    expect(converged.conflict).to.equal(null);
    expect(converged.status).to.equal('saved');
    expect(converged.persistedContent).to.equal('C');
    expect(converged.persistedRevision).to.equal(converged.revision);
    await session.flush('manual');
    expect(commits).to.deep.equal([]);
  });

  it('waits for a matching in-flight commit before clearing a converged conflict', async () => {
    const pending = deferred<void>();
    const session = new DocumentSession({ autoSaveDelayMs: 1_000 });
    await session.transitionTo(
      target('workspace:a.md', async () => pending.promise),
      'A',
    );

    edit(session, 'C');
    const flushing = session.flush('manual');
    await nextTask();
    expect(
      session.observeExternal({
        targetKey: 'workspace:a.md',
        content: 'B',
        sequence: 1,
      }),
    ).to.equal('conflict');
    expect(
      session.observeExternal({
        targetKey: 'workspace:a.md',
        content: 'C',
        sequence: 2,
      }),
    ).to.equal('conflict');
    expect(session.getSnapshot().status).to.equal('conflict');

    pending.resolve();
    const saved = await flushing;
    expect(saved.conflict).to.equal(null);
    expect(saved.status).to.equal('saved');
    expect(saved.persistedContent).to.equal('C');
  });

  it('resolves the latest external branch observed while an in-flight commit settles', async () => {
    const pending = deferred<void>();
    const session = new DocumentSession({ autoSaveDelayMs: 1_000 });
    await session.transitionTo(
      target('workspace:a.md', async () => pending.promise),
      'A',
    );

    edit(session, 'C');
    const flushing = session.flush('manual');
    void flushing.catch(() => undefined);
    await nextTask();
    expect(
      session.observeExternal({
        targetKey: 'workspace:a.md',
        content: 'B',
        sequence: 1,
      }),
    ).to.equal('conflict');

    const resolving = session.resolveConflict('use-external');
    await nextTask();
    expect(
      session.observeExternal({
        targetKey: 'workspace:a.md',
        content: 'A',
        sequence: 2,
      }),
    ).to.equal('conflict');

    pending.resolve();
    await flushing.catch(() => undefined);
    const resolved = await resolving;
    expect(resolved.content).to.equal('A');
    expect(resolved.persistedContent).to.equal('A');
    expect(resolved.status).to.equal('saved');
  });

  it('does not mistake its own in-flight write for an external conflict', async () => {
    const firstCommit = deferred<void>();
    const commits: DocumentCommitRequest[] = [];
    const session = new DocumentSession({ autoSaveDelayMs: 1_000 });
    await session.transitionTo(
      target('workspace:a.md', async (request) => {
        commits.push(request);
        if (commits.length === 1) await firstCommit.promise;
      }),
      'initial',
    );

    edit(session, 'first write');
    const flushing = session.flush();
    await nextTask();
    edit(session, 'newer typing');

    expect(
      session.observeExternal({ targetKey: 'workspace:a.md', content: 'first write' }),
    ).to.equal('ignored');
    expect(session.getSnapshot().conflict).to.equal(null);

    firstCommit.resolve();
    await flushing;
    expect(commits.map((commit) => commit.content)).to.deep.equal(['first write', 'newer typing']);
    expect(session.getSnapshot().status).to.equal('saved');
  });

  it('rejects a flush when a real external conflict arrives during its commit', async () => {
    const pending = deferred<void>();
    const session = new DocumentSession({ autoSaveDelayMs: 1_000 });
    await session.transitionTo(
      target('workspace:a.md', async () => pending.promise),
      'initial',
    );

    edit(session, 'local');
    const flushing = session.flush();
    await nextTask();
    expect(session.observeExternal({ targetKey: 'workspace:a.md', content: 'external' })).to.equal(
      'conflict',
    );
    pending.resolve();

    let thrown: unknown;
    try {
      await flushing;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).to.be.instanceOf(DocumentSessionConflictError);
    expect(session.getSnapshot().status).to.equal('conflict');
  });

  it('commits local content when keeping it after a clean external deletion', async () => {
    const commits: DocumentCommitRequest[] = [];
    const session = new DocumentSession({ autoSaveDelayMs: 1_000 });
    await session.transitionTo(
      target('workspace:a.md', async (request) => {
        commits.push(request);
      }),
      'initial',
    );

    expect(session.observeExternal({ targetKey: 'workspace:a.md', content: null })).to.equal(
      'conflict',
    );
    await session.resolveConflict('use-local');

    expect(commits).to.have.length(1);
    expect(commits[0].content).to.equal('initial');
    expect(commits[0].persistedContent).to.equal(null);
    expect(session.getSnapshot().status).to.equal('saved');
  });

  it('ignores an external read captured for a previous target', async () => {
    const session = new DocumentSession();
    await session.transitionTo(
      target('workspace:a.md', async () => {}),
      'a',
    );
    await session.transitionTo(
      target('workspace:b.md', async () => {}),
      'b',
    );

    expect(
      session.observeExternal({ targetKey: 'workspace:a.md', content: 'stale read' }),
    ).to.equal('ignored');
    expect(session.getSnapshot().content).to.equal('b');
  });

  it('invalidates the old editor scope after applying a clean external reload', async () => {
    const session = new DocumentSession();
    await session.transitionTo(
      target('workspace:a.md', async () => {}),
      'initial',
    );
    const old = session.getSnapshot();

    expect(
      session.observeExternal({
        targetKey: 'workspace:a.md',
        content: 'external',
        sequence: 1,
      }),
    ).to.equal('applied');
    expect(session.getSnapshot().generation).to.be.greaterThan(old.generation);
    expect(() =>
      session.edit('late initial', {
        targetKey: old.targetKey!,
        generation: old.generation,
      }),
    ).to.throw('obsolete document instance');
    expect(session.getSnapshot().content).to.equal('external');
  });

  it('ignores external watcher observations that complete out of sequence', async () => {
    const session = new DocumentSession();
    await session.transitionTo(
      target('workspace:a.md', async () => {}),
      'initial',
    );

    expect(
      session.observeExternal({
        targetKey: 'workspace:a.md',
        content: 'newest',
        sequence: 2,
      }),
    ).to.equal('applied');
    expect(
      session.observeExternal({
        targetKey: 'workspace:a.md',
        content: 'older',
        sequence: 1,
      }),
    ).to.equal('ignored');
    expect(session.getSnapshot().content).to.equal('newest');
  });

  it('flushes before loading a replacement document and can cancel stale loads', async () => {
    const pending = deferred<void>();
    let stored = 'initial';
    let loadCalls = 0;
    const session = new DocumentSession({ autoSaveDelayMs: 1_000 });
    await session.transitionTo(
      target('workspace:a.md', async (request) => {
        await pending.promise;
        stored = request.content;
      }),
      stored,
    );
    edit(session, 'latest');

    const transition = session.transitionWithLoad(async () => {
      loadCalls += 1;
      return { target: target('workspace:b.md', async () => {}), content: stored };
    });
    await nextTask();
    expect(loadCalls).to.equal(0);
    pending.resolve();
    await transition;
    expect(session.getSnapshot().content).to.equal('latest');
    expect(session.getSnapshot().targetKey).to.equal('workspace:b.md');

    const generation = session.getSnapshot().generation;
    const cancelled = await session.transitionWithLoad(async () => null);
    expect(cancelled).to.equal(null);
    expect(session.getSnapshot().targetKey).to.equal('workspace:b.md');
    expect(session.getSnapshot().generation).to.equal(generation);
  });

  it('rejects edits emitted by an editor mounted for an obsolete target', async () => {
    const session = new DocumentSession();
    await session.transitionTo(
      target('workspace:a.md', async () => {}),
      'a',
    );
    const old = session.getSnapshot();
    await session.transitionTo(
      target('workspace:b.md', async () => {}),
      'b',
    );

    expect(() =>
      session.edit('late a', {
        targetKey: old.targetKey!,
        generation: old.generation,
      }),
    ).to.throw('obsolete document instance');
    expect(session.getSnapshot().content).to.equal('b');
  });

  it('freezes after prepareClose and can resume when close is cancelled', async () => {
    const session = new DocumentSession({ autoSaveDelayMs: 1_000 });
    await session.transitionTo(
      target('workspace:a.md', async () => {}),
      'initial',
    );
    edit(session, 'latest');

    const prepared = await session.prepareClose();
    expect(prepared.lifecycle).to.equal('closing');
    expect(prepared.frozen).to.equal(true);
    expect(prepared.persistedRevision).to.equal(prepared.revision);
    expect(() => edit(session, 'too late')).to.throw();

    session.cancelClose();
    expect(session.getSnapshot().lifecycle).to.equal('open');
    expect(() => edit(session, 'resumed')).not.to.throw();
  });

  it('turns an optimistic filesystem mismatch into conflict state', async () => {
    const provider = new MemoryFileSystemProvider('memory', 'Memory');
    provider.seedText('/a.md', 'initial');
    const session = new DocumentSession({ autoSaveDelayMs: 1_000 });
    await session.transitionTo(createFileSystemDocumentTarget(provider, '/a.md'), 'initial');

    await provider.writeFile('/a.md', 'external');
    edit(session, 'local');
    let thrown: unknown;
    try {
      await session.flush();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(DocumentSessionConflictError);
    expect(session.getSnapshot().status).to.equal('conflict');
    expect(session.getSnapshot().conflict?.externalContent).to.equal('external');
    expect(await provider.readFile('/a.md')).to.equal('external');
  });

  it('refuses to replace malformed UTF-8 from an external document', async () => {
    const provider = new MemoryFileSystemProvider('memory-invalid-utf8', 'Memory');
    await provider.v2.writeFile(parseWorkspacePath('/a.md'), new Uint8Array([0xc3, 0x28]), {
      mode: 'create',
      createParents: true,
      expectedVersion: null,
    });
    const commitTarget = createFileSystemDocumentTarget(provider, '/a.md');

    let failure: unknown;
    try {
      await commitTarget.commit({
        targetKey: commitTarget.key,
        revision: 2,
        persistedRevision: 1,
        persistedContent: 'initial',
        content: 'local',
        reason: 'manual',
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).to.have.property('name', 'FsError');
    expect(failure).to.have.property('code', 'corrupt');
    expect(new Uint8Array((await provider.v2.readFile(parseWorkspacePath('/a.md')))!.data)).to.eql(
      new Uint8Array([0xc3, 0x28]),
    );
  });

  it('lets only one conditional backend commit win for the same baseline', async () => {
    const provider = new MemoryFileSystemProvider('memory-cas', 'Memory');
    provider.seedText('/a.md', 'initial');
    const first = createFileSystemDocumentTarget(provider, '/a.md');
    const second = createFileSystemDocumentTarget(provider, '/a.md');
    const request = {
      targetKey: first.key,
      revision: 2,
      persistedRevision: 1,
      persistedContent: 'initial',
      reason: 'manual' as const,
    };

    const results = await Promise.allSettled([
      first.commit({ ...request, content: 'first' }),
      second.commit({ ...request, targetKey: second.key, content: 'second' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).to.have.length(1);
    expect(results.filter((result) => result.status === 'rejected')).to.have.length(1);
    expect(['first', 'second']).to.include(await provider.readFile('/a.md'));
  });
});
