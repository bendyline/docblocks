import { expect } from 'chai';
import {
  DocumentSession,
  DocumentSessionConflictError,
  type DocumentCommitRequest,
  type DocumentCommitTarget,
  type DocumentSessionSnapshot,
} from '../src/document/index.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function target(
  key: string,
  commit: (request: DocumentCommitRequest) => Promise<void>,
): DocumentCommitTarget {
  return { key, commit };
}

function edit(session: DocumentSession, content: string): number {
  const snapshot = session.getSnapshot();
  if (!snapshot.targetKey) throw new Error('Test session has no target.');
  return session.edit(content, {
    targetKey: snapshot.targetKey,
    generation: snapshot.generation,
  });
}

async function nextTask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected promise to reject.');
}

describe('DocumentSession adversarial lifecycle integration', () => {
  it('finishes an in-flight save before rename and commits later edits only to the new target', async () => {
    const oldCommit = deferred<void>();
    const oldCommitStarted = deferred<void>();
    const operations: string[] = [];
    const requests: DocumentCommitRequest[] = [];
    const session = new DocumentSession({ autoSaveDelayMs: 60_000 });
    await session.transitionTo(
      target('workspace:old.md', async (request) => {
        requests.push(request);
        operations.push(`old:${request.content}`);
        oldCommitStarted.resolve();
        await oldCommit.promise;
      }),
      'initial',
    );

    const oldScope = session.getSnapshot();
    edit(session, 'saved before rename');
    const saving = session.flush('manual');
    await oldCommitStarted.promise;

    const renaming = session.retarget(
      target('workspace:new.md', async (request) => {
        requests.push(request);
        operations.push(`new:${request.content}`);
      }),
      async () => {
        operations.push('move');
      },
    );
    await nextTask();

    expect(session.getSnapshot().lifecycle).to.equal('transitioning');
    expect(session.getSnapshot().frozen).to.equal(true);
    expect(operations).to.deep.equal(['old:saved before rename']);

    oldCommit.resolve();
    await Promise.all([saving, renaming]);

    expect(operations).to.deep.equal(['old:saved before rename', 'move']);
    expect(session.getSnapshot().targetKey).to.equal('workspace:new.md');
    expect(() =>
      session.edit('late callback from old editor', {
        targetKey: oldScope.targetKey!,
        generation: oldScope.generation,
      }),
    ).to.throw('obsolete document instance');

    edit(session, 'saved after rename');
    await session.flush('manual');

    expect(operations).to.deep.equal(['old:saved before rename', 'move', 'new:saved after rename']);
    expect(requests[1].persistedContent).to.equal('saved before rename');
    expect(requests[1].reason).to.equal('manual');
  });

  it('makes delete final even when a newer edit is queued behind an in-flight save', async () => {
    const commit = deferred<void>();
    const commitStarted = deferred<void>();
    const operations: string[] = [];
    const committedContent: string[] = [];
    const session = new DocumentSession({ autoSaveDelayMs: 5 });
    await session.transitionTo(
      target('workspace:a.md', async (request) => {
        operations.push(`commit:${request.content}`);
        committedContent.push(request.content);
        commitStarted.resolve();
        await commit.promise;
      }),
      'initial',
    );

    edit(session, 'in flight');
    const saving = session.flush('manual');
    await commitStarted.promise;
    edit(session, 'queued immediately before delete');

    const deleting = session.delete(async () => {
      operations.push('delete');
    });
    await nextTask();
    expect(session.getSnapshot().lifecycle).to.equal('transitioning');
    expect(session.getSnapshot().frozen).to.equal(true);

    commit.resolve();
    await Promise.all([saving, deleting]);
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(operations).to.deep.equal(['commit:in flight', 'delete']);
    expect(committedContent).to.deep.equal(['in flight']);
    expect(session.getSnapshot().status).to.equal('closed');
    expect(session.getSnapshot().targetKey).to.equal(null);
  });

  it('flushes the old revision and cancels a superseded rapid transition before loading the winner', async () => {
    const firstLoadStarted = deferred<void>();
    const releaseFirstLoad = deferred<void>();
    const operations: string[] = [];
    const session = new DocumentSession({ autoSaveDelayMs: 60_000 });
    await session.transitionTo(
      target('workspace:a.md', async (request) => {
        operations.push(`save-a:${request.content}`);
      }),
      'a',
    );
    edit(session, 'latest a');

    let navigationEpoch = 1;
    const firstEpoch = navigationEpoch;
    const firstNavigation = session.transitionWithLoad(async () => {
      operations.push('load-b:start');
      firstLoadStarted.resolve();
      await releaseFirstLoad.promise;
      if (firstEpoch !== navigationEpoch) {
        operations.push('load-b:cancel');
        return null;
      }
      return {
        target: target('workspace:b.md', async () => {}),
        content: 'b',
      };
    });
    await firstLoadStarted.promise;

    navigationEpoch += 1;
    const secondNavigation = session.transitionWithLoad(async () => {
      operations.push('load-c');
      return {
        target: target('workspace:c.md', async () => {}),
        content: 'c',
      };
    });
    releaseFirstLoad.resolve();

    const [firstResult, secondResult] = await Promise.all([firstNavigation, secondNavigation]);

    expect(firstResult).to.equal(null);
    expect(secondResult?.targetKey).to.equal('workspace:c.md');
    expect(operations).to.deep.equal([
      'save-a:latest a',
      'load-b:start',
      'load-b:cancel',
      'load-c',
    ]);
    expect(session.getSnapshot().targetKey).to.equal('workspace:c.md');
    expect(session.getSnapshot().content).to.equal('c');
  });

  it('blocks manual save and close acknowledgement when an external change arrives mid-save', async () => {
    const commit = deferred<void>();
    const commitStarted = deferred<void>();
    const session = new DocumentSession({ autoSaveDelayMs: 60_000 });
    await session.transitionTo(
      target('workspace:a.md', async () => {
        commitStarted.resolve();
        await commit.promise;
      }),
      'initial',
    );

    edit(session, 'local draft');
    const saving = session.flush('manual');
    void saving.catch(() => undefined);
    await commitStarted.promise;
    expect(
      session.observeExternal({
        targetKey: 'workspace:a.md',
        content: 'external edit',
        sequence: 1,
      }),
    ).to.equal('conflict');

    const closing = session.prepareClose();
    const closeError = await rejectionOf(closing);
    expect(closeError).to.be.instanceOf(DocumentSessionConflictError);
    expect(session.getSnapshot().lifecycle).to.equal('open');
    expect(session.getSnapshot().frozen).to.equal(false);

    commit.resolve();
    const saveError = await rejectionOf(saving);
    expect(saveError).to.be.instanceOf(DocumentSessionConflictError);
    expect(session.getSnapshot().status).to.equal('conflict');
    expect(session.getSnapshot().content).to.equal('local draft');
    expect(session.getSnapshot().conflict?.externalContent).to.equal('external edit');
  });

  it('rejects a failed manual save without acknowledging its revision, then retries honestly', async () => {
    const requests: DocumentCommitRequest[] = [];
    let shouldFail = true;
    const session = new DocumentSession({ autoSaveDelayMs: 60_000 });
    await session.transitionTo(
      target('workspace:a.md', async (request) => {
        requests.push(request);
        if (shouldFail) {
          shouldFail = false;
          throw new Error('disk full');
        }
      }),
      'initial',
    );
    edit(session, 'must persist');

    const failure = await rejectionOf(session.flush('manual'));
    expect(failure).to.be.instanceOf(Error);
    expect((failure as Error).message).to.equal('disk full');
    expect(session.getSnapshot().status).to.equal('error');
    expect(session.getSnapshot().persistedRevision).to.be.lessThan(session.getSnapshot().revision);
    expect(session.getSnapshot().persistedContent).to.equal('initial');

    const saved = await session.flush('manual');
    expect(requests.map((request) => request.reason)).to.deep.equal(['manual', 'manual']);
    expect(saved.status).to.equal('saved');
    expect(saved.persistedRevision).to.equal(saved.revision);
    expect(saved.persistedContent).to.equal('must persist');
  });

  it('waits for a pending close write and reopens the session after a close write fails', async () => {
    const firstCommit = deferred<void>();
    const firstCommitStarted = deferred<void>();
    const requests: DocumentCommitRequest[] = [];
    let failNextCommit = false;
    const session = new DocumentSession({ autoSaveDelayMs: 60_000 });
    await session.transitionTo(
      target('workspace:a.md', async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          firstCommitStarted.resolve();
          await firstCommit.promise;
        } else if (failNextCommit) {
          failNextCommit = false;
          throw new Error('device unavailable');
        }
      }),
      'initial',
    );

    edit(session, 'close must await this');
    const closing = session.prepareClose();
    await firstCommitStarted.promise;

    expect(session.getSnapshot().lifecycle).to.equal('closing');
    expect(session.getSnapshot().frozen).to.equal(true);
    expect(session.getSnapshot().status).to.equal('saving');
    expect(() => edit(session, 'late close edit')).to.throw('not open');

    firstCommit.resolve();
    const prepared = await closing;
    expect(prepared.lifecycle).to.equal('closing');
    expect(prepared.persistedRevision).to.equal(prepared.revision);
    expect(requests[0].reason).to.equal('close');

    session.cancelClose();
    edit(session, 'second close attempt');
    failNextCommit = true;
    const closeFailure = await rejectionOf(session.prepareClose());

    expect(closeFailure).to.be.instanceOf(Error);
    expect((closeFailure as Error).message).to.equal('device unavailable');
    const failedSnapshot: DocumentSessionSnapshot = session.getSnapshot();
    expect(failedSnapshot.lifecycle).to.equal('open');
    expect(failedSnapshot.frozen).to.equal(false);
    expect(failedSnapshot.status).to.equal('error');
    expect(failedSnapshot.persistedRevision).to.be.lessThan(failedSnapshot.revision);
    expect(() => edit(session, 'editing resumes after blocked close')).not.to.throw();
    expect(requests[1].reason).to.equal('close');
    await session.cancel();
  });
});
