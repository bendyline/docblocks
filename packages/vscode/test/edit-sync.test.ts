import { expect } from 'chai';
import {
  VscodeDocumentSync,
  withApplyingEditFlag,
  type HostDocumentAdapter,
  type HostDocumentSnapshot,
} from '../src/editSync.js';
import { parseWebviewToExtensionMessage } from '../src/messages.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeDocumentAdapter implements HostDocumentAdapter {
  public readonly key = 'file:///workspace/readme.md';
  public content = 'initial';
  public version = 1;
  public commits: string[] = [];
  public activeCommits = 0;
  public maxActiveCommits = 0;
  public failNextCommit = false;
  public failNextSaveAfterReplace = false;

  public async read(): Promise<HostDocumentSnapshot> {
    return { content: this.content, version: this.version };
  }

  public async replaceAndSave(content: string): Promise<HostDocumentSnapshot> {
    this.activeCommits += 1;
    this.maxActiveCommits = Math.max(this.maxActiveCommits, this.activeCommits);
    try {
      await wait(2);
      if (this.failNextCommit) {
        this.failNextCommit = false;
        throw new Error('disk full');
      }
      this.content = content;
      this.version += 1;
      if (this.failNextSaveAfterReplace) {
        this.failNextSaveAfterReplace = false;
        throw new Error('save rejected after edit');
      }
      this.commits.push(content);
      return this.read();
    } finally {
      this.activeCommits -= 1;
    }
  }

  public changeExternally(content: string): HostDocumentSnapshot {
    this.content = content;
    this.version += 1;
    return { content, version: this.version };
  }
}

function editEnvelope(sync: VscodeDocumentSync, clientRevision: number, content: string) {
  const state = sync.getSnapshot();
  return {
    sessionId: state.sessionId,
    baseDocumentVersion: state.baseDocumentVersion,
    clientRevision,
    content,
  };
}

function saveEnvelope(sync: VscodeDocumentSync) {
  const state = sync.getSnapshot();
  return {
    sessionId: state.sessionId,
    baseDocumentVersion: state.baseDocumentVersion,
    clientRevision: state.acknowledgedClientRevision,
  };
}

describe('VS Code edit sync', () => {
  it('coalesces immediate complete edits and serializes the latest autosave', async () => {
    const adapter = new FakeDocumentAdapter();
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 5,
      createSessionId: () => 'session-a',
    });

    expect(sync.acceptEdit(editEnvelope(sync, 1, 'first')).accepted).to.equal(true);
    expect(sync.acceptEdit(editEnvelope(sync, 2, 'latest')).accepted).to.equal(true);
    await wait(30);

    expect(adapter.commits).to.deep.equal(['latest']);
    expect(adapter.content).to.equal('latest');
    expect(adapter.maxActiveCommits).to.equal(1);
    expect(sync.getSnapshot().session.status).to.equal('saved');
    sync.dispose();
  });

  it('rejects stale sessions, stale document baselines, and skipped revisions', async () => {
    const adapter = new FakeDocumentAdapter();
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 1_000,
      createSessionId: () => 'session-a',
    });
    const current = editEnvelope(sync, 1, 'local');

    expect(sync.acceptEdit({ ...current, sessionId: 'obsolete' }).accepted).to.equal(false);
    expect(sync.acceptEdit({ ...current, baseDocumentVersion: 99 }).accepted).to.equal(false);
    expect(sync.acceptEdit({ ...current, clientRevision: 2 }).accepted).to.equal(false);
    expect(sync.acceptEdit(current).accepted).to.equal(true);
    expect(sync.getSnapshot().acknowledgedClientRevision).to.equal(1);
    sync.dispose();
  });

  it('reports manual-save failure and succeeds honestly when retried', async () => {
    const adapter = new FakeDocumentAdapter();
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 1_000,
      createSessionId: () => 'session-a',
    });
    sync.acceptEdit(editEnvelope(sync, 1, 'local'));
    adapter.failNextCommit = true;

    let failure: unknown;
    try {
      await sync.save(saveEnvelope(sync));
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    expect(sync.getSnapshot().session.status).to.equal('error');
    expect(adapter.content).to.equal('initial');

    const saved = await sync.save(saveEnvelope(sync));
    expect(saved.status).to.equal('saved');
    expect(saved.persistedRevision).to.equal(saved.revision);
    expect(adapter.content).to.equal('local');
    sync.dispose();
  });

  it('retries a save that failed after VS Code already applied the edit', async () => {
    const adapter = new FakeDocumentAdapter();
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 1_000,
      createSessionId: () => 'session-a',
    });
    sync.acceptEdit(editEnvelope(sync, 1, 'locally applied'));
    adapter.failNextSaveAfterReplace = true;

    let failure: unknown;
    try {
      await sync.save(saveEnvelope(sync));
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    expect(adapter.content).to.equal('locally applied');
    expect(sync.getSnapshot().session.status).to.equal('error');

    await sync.save(saveEnvelope(sync));
    expect(sync.getSnapshot().session.status).to.equal('saved');
    expect(sync.getSnapshot().session.conflict).to.equal(null);
    sync.dispose();
  });

  it('adopts a clean external change and rotates the client branch', async () => {
    const adapter = new FakeDocumentAdapter();
    let nextId = 0;
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 1_000,
      createSessionId: () => `session-${++nextId}`,
    });
    const oldSessionId = sync.getSnapshot().sessionId;

    const result = sync.observeExternal(adapter.changeExternally('external'));

    expect(result).to.equal('applied');
    expect(sync.getSnapshot().session.content).to.equal('external');
    expect(sync.getSnapshot().sessionId).to.not.equal(oldSessionId);
    expect(sync.getSnapshot().acknowledgedClientRevision).to.equal(0);
    sync.dispose();
  });

  it('preserves dirty local text on external change until the user resolves it', async () => {
    const adapter = new FakeDocumentAdapter();
    let nextId = 0;
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 1_000,
      createSessionId: () => `session-${++nextId}`,
    });
    sync.acceptEdit(editEnvelope(sync, 1, 'local'));

    const result = sync.observeExternal(adapter.changeExternally('external'));

    expect(result).to.equal('conflict');
    expect(sync.getSnapshot().session.status).to.equal('conflict');
    expect(sync.getSnapshot().session.content).to.equal('local');
    expect(adapter.content).to.equal('external');

    let saveFailure: unknown;
    try {
      await sync.save(saveEnvelope(sync));
    } catch (error: unknown) {
      saveFailure = error;
    }
    expect(saveFailure).to.be.instanceOf(Error);

    await sync.resolveConflict('use-external');
    expect(sync.getSnapshot().session.content).to.equal('external');
    expect(sync.getSnapshot().session.status).to.equal('saved');
    sync.dispose();
  });

  it('detects an external version change again at commit time', async () => {
    const adapter = new FakeDocumentAdapter();
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 1_000,
      createSessionId: () => 'session-a',
    });
    sync.acceptEdit(editEnvelope(sync, 1, 'local'));
    adapter.changeExternally('external without watcher delivery');

    let failure: unknown;
    try {
      await sync.save(saveEnvelope(sync));
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(Error);
    expect(sync.getSnapshot().session.status).to.equal('conflict');
    expect(sync.getSnapshot().session.content).to.equal('local');
    expect(adapter.content).to.equal('external without watcher delivery');
    sync.dispose();
  });

  it('overwrites an external branch only after an explicit keep-local choice', async () => {
    const adapter = new FakeDocumentAdapter();
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 1_000,
      createSessionId: () => 'session-a',
    });
    sync.acceptEdit(editEnvelope(sync, 1, 'local'));
    sync.observeExternal(adapter.changeExternally('external'));

    await sync.resolveConflict('use-local');

    expect(adapter.content).to.equal('local');
    expect(sync.getSnapshot().session.status).to.equal('saved');
    sync.dispose();
  });

  it('uses the latest external text when it reverts before resolution', async () => {
    const adapter = new FakeDocumentAdapter();
    let nextId = 0;
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 1_000,
      createSessionId: () => `session-${++nextId}`,
    });
    sync.acceptEdit(editEnvelope(sync, 1, 'local'));
    sync.observeExternal(adapter.changeExternally('first external'));
    sync.observeExternal(adapter.changeExternally('initial'));

    await sync.resolveConflict('use-external');

    expect(sync.getSnapshot().session.content).to.equal('initial');
    expect(sync.getSnapshot().session.status).to.equal('saved');
    sync.dispose();
  });

  it('flushes a host-owned draft during close instead of waiting for autosave', async () => {
    const adapter = new FakeDocumentAdapter();
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 60_000,
      createSessionId: () => 'session-a',
    });
    sync.acceptEdit(editEnvelope(sync, 1, 'close-safe'));

    const closed = await sync.prepareClose();

    expect(closed.lifecycle).to.equal('closing');
    expect(closed.persistedRevision).to.equal(closed.revision);
    expect(adapter.content).to.equal('close-safe');
    sync.dispose();
  });

  it('resets the host applying-edit guard after applyEdit fails', async () => {
    const flagTransitions: boolean[] = [];
    let thrown: unknown;

    try {
      await withApplyingEditFlag(
        (isApplying) => flagTransitions.push(isApplying),
        async () => {
          throw new Error('apply failed');
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(Error);
    expect(flagTransitions).to.deep.equal([true, false]);
  });
});

describe('VS Code editor message guards', () => {
  it('accepts a complete revisioned edit envelope', () => {
    expect(
      parseWebviewToExtensionMessage({
        type: 'edit',
        content: 'hello',
        sessionId: 'session-a',
        clientRevision: 2,
        baseDocumentVersion: 7,
      }),
    ).to.deep.equal({
      type: 'edit',
      content: 'hello',
      sessionId: 'session-a',
      clientRevision: 2,
      baseDocumentVersion: 7,
    });
  });

  it('rejects legacy, malformed, and unknown document messages', () => {
    expect(parseWebviewToExtensionMessage({ type: 'edit', content: 'legacy' })).to.equal(null);
    expect(
      parseWebviewToExtensionMessage({
        type: 'save',
        sessionId: 'session-a',
        requestId: -1,
        clientRevision: 1,
        baseDocumentVersion: 1,
      }),
    ).to.equal(null);
    expect(parseWebviewToExtensionMessage({ type: 'surprise' })).to.equal(null);
  });
});
