import { expect } from 'chai';
import type {
  DocumentCommitRequest,
  DocumentCommitTarget,
  DocumentSession,
} from '@bendyline/docblocks/document';
import { useDocumentSession } from '../src/hooks/useDocumentSession.js';
import { act, renderHook } from './helpers/renderHook.js';

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

function edit(session: DocumentSession, content: string): void {
  const snapshot = session.getSnapshot();
  if (!snapshot.targetKey) throw new Error('Test session has no target.');
  session.edit(content, {
    targetKey: snapshot.targetKey,
    generation: snapshot.generation,
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected promise to reject.');
}

describe('useDocumentSession lifecycle integration', () => {
  it('publishes dirty, saving, error, and saved states for an honest manual save', async () => {
    const firstCommit = deferred<void>();
    const firstCommitStarted = deferred<void>();
    const requests: DocumentCommitRequest[] = [];
    const handle = await renderHook(() => useDocumentSession(60_000), undefined);
    const session = handle.result.current.session;

    await act(async () => {
      await session.transitionTo(
        target('workspace:a.md', async (request) => {
          requests.push(request);
          if (requests.length === 1) {
            firstCommitStarted.resolve();
            await firstCommit.promise;
          }
        }),
        'initial',
      );
    });
    await act(async () => {
      edit(session, 'manual save');
    });
    expect(handle.result.current.snapshot.status).to.equal('dirty');

    let saving!: Promise<unknown>;
    await act(async () => {
      saving = session.flush('manual');
      void saving.catch(() => undefined);
      await firstCommitStarted.promise;
    });
    expect(handle.result.current.snapshot.status).to.equal('saving');

    let failure: unknown;
    await act(async () => {
      firstCommit.reject(new Error('write failed'));
      failure = await rejectionOf(saving);
    });
    expect(failure).to.be.instanceOf(Error);
    expect(handle.result.current.snapshot.status).to.equal('error');
    expect(handle.result.current.snapshot.persistedRevision).to.be.lessThan(
      handle.result.current.snapshot.revision,
    );

    await act(async () => {
      await session.flush('manual');
    });
    expect(requests.map((request) => request.reason)).to.deep.equal(['manual', 'manual']);
    expect(handle.result.current.snapshot.status).to.equal('saved');
    expect(handle.result.current.snapshot.persistedContent).to.equal('manual save');

    await handle.unmount();
  });

  it('publishes a frozen closing state while pending and restores an editable error state on failure', async () => {
    const closeCommit = deferred<void>();
    const closeCommitStarted = deferred<void>();
    const handle = await renderHook(() => useDocumentSession(60_000), undefined);
    const session = handle.result.current.session;

    await act(async () => {
      await session.transitionTo(
        target('workspace:a.md', async () => {
          closeCommitStarted.resolve();
          await closeCommit.promise;
        }),
        'initial',
      );
      edit(session, 'pending close content');
    });

    let closing!: Promise<unknown>;
    await act(async () => {
      closing = session.prepareClose();
      void closing.catch(() => undefined);
      await closeCommitStarted.promise;
    });
    expect(handle.result.current.snapshot.lifecycle).to.equal('closing');
    expect(handle.result.current.snapshot.frozen).to.equal(true);
    expect(handle.result.current.snapshot.status).to.equal('saving');
    expect(() => edit(session, 'late editor callback')).to.throw('not open');

    let failure: unknown;
    await act(async () => {
      closeCommit.reject(new Error('close write failed'));
      failure = await rejectionOf(closing);
    });
    expect(failure).to.be.instanceOf(Error);
    expect(handle.result.current.snapshot.lifecycle).to.equal('open');
    expect(handle.result.current.snapshot.frozen).to.equal(false);
    expect(handle.result.current.snapshot.status).to.equal('error');

    await act(async () => {
      edit(session, 'editing resumed');
    });
    expect(handle.result.current.snapshot.status).to.equal('dirty');
    expect(handle.result.current.snapshot.content).to.equal('editing resumed');

    await act(async () => {
      await session.cancel();
    });
    await handle.unmount();
  });
});
