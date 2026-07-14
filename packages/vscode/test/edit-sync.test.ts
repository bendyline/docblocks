import { expect } from 'chai';
import { parseWebviewToExtensionMessage } from '@bendyline/docblocks/vscode';
import { WebviewDocumentClient } from '../webview/src/webviewDocumentClient.js';
import {
  DEFAULT_VSCODE_AUTO_SAVE_DELAY_MS,
  HostDocumentChangedError,
  VscodeDocumentSync,
  withApplyingEditFlag,
  type HostDocumentAdapter,
  type HostDocumentSnapshot,
} from '../src/editSync.js';

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
  public transformOnSave: ((content: string) => string) | null = null;
  public beforeReplacePreconditionCheck: (() => void) | null = null;

  public async read(): Promise<HostDocumentSnapshot> {
    return { content: this.content, version: this.version };
  }

  public async replaceAndSave(
    content: string,
    expected: HostDocumentSnapshot,
  ): Promise<HostDocumentSnapshot> {
    this.activeCommits += 1;
    this.maxActiveCommits = Math.max(this.maxActiveCommits, this.activeCommits);
    try {
      const interleave = this.beforeReplacePreconditionCheck;
      this.beforeReplacePreconditionCheck = null;
      interleave?.();
      const actual = await this.read();
      if (actual.version !== expected.version || actual.content !== expected.content) {
        throw new HostDocumentChangedError(
          actual,
          'The fake host document changed immediately before replacement.',
        );
      }
      await wait(2);
      if (this.failNextCommit) {
        this.failNextCommit = false;
        throw new Error('disk full');
      }
      this.content = this.transformOnSave?.(content) ?? content;
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
  it('waits twenty seconds of edit inactivity before autosaving by default', async () => {
    expect(DEFAULT_VSCODE_AUTO_SAVE_DELAY_MS).to.equal(20_000);
    const adapter = new FakeDocumentAdapter();
    const sync = await VscodeDocumentSync.create(adapter, {
      createSessionId: () => 'session-a',
    });

    expect(sync.acceptEdit(editEnvelope(sync, 1, 'pending')).accepted).to.equal(true);
    await wait(30);

    expect(adapter.commits).to.deep.equal([]);
    expect(sync.getSnapshot().session.status).to.equal('dirty');
    await sync.save(saveEnvelope(sync));
    expect(adapter.commits).to.deep.equal(['pending']);
    sync.dispose();
  });

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

  it('applies a live autosave preference while retaining manual Save', async () => {
    const adapter = new FakeDocumentAdapter();
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 5,
      autoSaveEnabled: false,
      createSessionId: () => 'session-a',
    });

    expect(sync.acceptEdit(editEnvelope(sync, 1, 'manual')).accepted).to.equal(true);
    await wait(20);
    expect(adapter.commits).to.deep.equal([]);

    await sync.save(saveEnvelope(sync));
    expect(adapter.commits).to.deep.equal(['manual']);

    expect(sync.acceptEdit(editEnvelope(sync, 2, 'automatic')).accepted).to.equal(true);
    sync.setAutoSaveEnabled(true);
    await wait(20);
    expect(adapter.commits).to.deep.equal(['manual', 'automatic']);
    sync.dispose();
  });

  it('rejects stale branches but accepts a coalesced complete-snapshot revision jump', async () => {
    const adapter = new FakeDocumentAdapter();
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 1_000,
      createSessionId: () => 'session-a',
    });
    const current = editEnvelope(sync, 1, 'local');

    expect(sync.acceptEdit({ ...current, sessionId: 'obsolete' }).accepted).to.equal(false);
    expect(sync.acceptEdit({ ...current, baseDocumentVersion: 99 }).accepted).to.equal(false);
    expect(
      sync.acceptEdit({ ...current, clientRevision: 200, content: 'coalesced latest' }).accepted,
    ).to.equal(true);
    expect(sync.getSnapshot().acknowledgedClientRevision).to.equal(200);
    expect(sync.getSnapshot().session.content).to.equal('coalesced latest');
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

  it('absorbs a version-only host update before committing pending text', async () => {
    const adapter = new FakeDocumentAdapter();
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 1_000,
      createSessionId: () => 'session-a',
    });
    sync.acceptEdit(editEnvelope(sync, 1, 'local'));
    adapter.changeExternally('initial');

    await sync.save(saveEnvelope(sync));

    expect(adapter.content).to.equal('local');
    expect(adapter.commits).to.deep.equal(['local']);
    expect(sync.getSnapshot().session.conflict).to.equal(null);
    sync.dispose();
  });

  it('acknowledges an already-converged host snapshot without rewriting it', async () => {
    const adapter = new FakeDocumentAdapter();
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 1_000,
      createSessionId: () => 'session-a',
    });
    sync.acceptEdit(editEnvelope(sync, 1, 'same local text'));
    adapter.changeExternally('same local text');

    await sync.save(saveEnvelope(sync));

    expect(adapter.commits).to.deep.equal([]);
    expect(sync.getSnapshot().session.status).to.equal('saved');
    expect(sync.getSnapshot().session.conflict).to.equal(null);
    sync.dispose();
  });

  it('accepts VS Code line-ending and final-newline normalization during its own save', async () => {
    const adapter = new FakeDocumentAdapter();
    adapter.content = 'testing!\n\n\n';
    adapter.transformOnSave = (content) => `${content.replace(/\n/gu, '\r\n')}\r\n\r\n`;
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 1_000,
      createSessionId: () => 'session-a',
    });
    sync.acceptEdit(editEnvelope(sync, 1, ''));

    await sync.save(saveEnvelope(sync));

    expect(adapter.commits).to.deep.equal(['']);
    expect(adapter.content).to.equal('\r\n\r\n');
    expect(sync.getSnapshot().session.status).to.equal('saved');
    expect(sync.getSnapshot().session.conflict).to.equal(null);
    sync.dispose();
  });

  it('still conflicts when save-time changes include non-newline characters', async () => {
    const adapter = new FakeDocumentAdapter();
    adapter.transformOnSave = (content) => `${content}external`;
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 1_000,
      createSessionId: () => 'session-a',
    });
    sync.acceptEdit(editEnvelope(sync, 1, 'local'));

    let failure: unknown;
    try {
      await sync.save(saveEnvelope(sync));
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(Error);
    expect(sync.getSnapshot().session.status).to.equal('conflict');
    expect(sync.getSnapshot().session.content).to.equal('local');
    expect(adapter.content).to.equal('localexternal');
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

  it('rejects a delayed webview edit after a clean external branch replaces its baseline', async () => {
    const adapter = new FakeDocumentAdapter();
    let nextId = 0;
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 5,
      createSessionId: () => `session-${++nextId}`,
    });
    const delayedEdit = editEnvelope(sync, 1, 'stale webview snapshot');

    expect(sync.observeExternal(adapter.changeExternally('new external text'))).to.equal('applied');
    expect(sync.acceptEdit(delayedEdit).accepted).to.equal(false);
    await wait(20);

    expect(adapter.content).to.equal('new external text');
    expect(adapter.commits).to.deep.equal([]);
    expect(sync.getSnapshot().session.content).to.equal('new external text');
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

  it('does not let an already-scheduled local autosave overwrite an external edit', async () => {
    const adapter = new FakeDocumentAdapter();
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 5,
      createSessionId: () => 'session-a',
    });
    expect(sync.acceptEdit(editEnvelope(sync, 1, 'pending local snapshot')).accepted).to.equal(
      true,
    );

    expect(sync.observeExternal(adapter.changeExternally('external wins until resolved'))).to.equal(
      'conflict',
    );
    await wait(20);

    expect(adapter.content).to.equal('external wins until resolved');
    expect(adapter.commits).to.deep.equal([]);
    expect(sync.getSnapshot().session.status).to.equal('conflict');
    expect(sync.getSnapshot().session.content).to.equal('pending local snapshot');
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

  it('rejects an external edit injected between the initial read and replacement precondition', async () => {
    const adapter = new FakeDocumentAdapter();
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 1_000,
      createSessionId: () => 'session-a',
    });
    sync.acceptEdit(editEnvelope(sync, 1, 'local replacement'));
    adapter.beforeReplacePreconditionCheck = () => {
      adapter.changeExternally('external in the read-to-replace gap');
    };

    let failure: unknown;
    try {
      await sync.save(saveEnvelope(sync));
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(Error);
    expect(sync.getSnapshot().session.status).to.equal('conflict');
    expect(sync.getSnapshot().session.content).to.equal('local replacement');
    expect(adapter.content).to.equal('external in the read-to-replace gap');
    expect(adapter.commits).to.deep.equal([]);
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

  it('does not rewrite or re-notify when branches converge before Keep mine', async () => {
    const adapter = new FakeDocumentAdapter();
    let nextId = 0;
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 1_000,
      createSessionId: () => `session-${++nextId}`,
    });
    sync.acceptEdit(editEnvelope(sync, 1, 'local'));
    sync.observeExternal(adapter.changeExternally('external'));
    adapter.changeExternally('local');

    await sync.resolveConflict('use-local');

    expect(adapter.commits).to.deep.equal([]);
    expect(sync.getSnapshot().session.status).to.equal('saved');
    expect(sync.getSnapshot().session.conflict).to.equal(null);
    sync.dispose();
  });

  it('reports bounded conflict diagnostics from the two complete snapshots', async () => {
    const adapter = new FakeDocumentAdapter();
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 1_000,
      createSessionId: () => 'session-a',
      now: () => 1_000,
    });
    sync.acceptEdit(editEnvelope(sync, 1, 'mine💡'));
    const external = adapter.changeExternally('theirs');
    sync.observeExternal({ ...external, observedAt: 2_000, isDirty: true });

    expect(sync.getSnapshot().conflict).to.deep.equal({
      localBaseDocumentVersion: 1,
      externalDocumentVersion: 2,
      localBytes: 8,
      externalBytes: 6,
      localEditedAt: 1_000,
      externalObservedAt: 2_000,
      externalIsDirty: true,
    });
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

describe('VS Code webview document scope', () => {
  it('cannot relabel an obsolete editor callback as an edit on a newer host branch', () => {
    const client = new WebviewDocumentClient();
    const originalScope = client.acceptContent({
      type: 'setContent',
      content: 'original',
      documentVersion: 1,
      fileName: 'document.md',
      sessionId: 'session-a',
      sessionRevision: 0,
      acknowledgedClientRevision: 0,
    });
    expect(client.armEdits(originalScope)).to.equal(true);
    expect(client.createEdit(originalScope, 'local')).to.include({
      type: 'edit',
      sessionId: 'session-a',
      clientRevision: 1,
      baseDocumentVersion: 1,
    });

    const externalScope = client.acceptContent({
      type: 'setContent',
      content: 'external',
      documentVersion: 2,
      fileName: 'document.md',
      sessionId: 'session-b',
      sessionRevision: 0,
      acknowledgedClientRevision: 0,
    });

    expect(client.armEdits(originalScope)).to.equal(false);
    expect(client.createEdit(originalScope, 'stale queued callback')).to.equal(null);
    expect(client.armEdits(externalScope)).to.equal(true);
    expect(client.createEdit(externalScope, 'new branch edit')).to.deep.equal({
      type: 'edit',
      content: 'new branch edit',
      sessionId: 'session-b',
      clientRevision: 1,
      baseDocumentVersion: 2,
    });
  });

  it('advances the editor generation even when replacement text is identical', () => {
    const client = new WebviewDocumentClient();
    const first = client.acceptContent({
      type: 'setContent',
      content: 'same',
      documentVersion: 1,
      fileName: 'document.md',
      sessionId: 'session-a',
      sessionRevision: 0,
      acknowledgedClientRevision: 0,
    });
    const replacement = client.acceptContent({
      type: 'setContent',
      content: 'same',
      documentVersion: 2,
      fileName: 'document.md',
      sessionId: 'session-b',
      sessionRevision: 0,
      acknowledgedClientRevision: 0,
    });

    expect(replacement.generation).to.equal(first.generation + 1);
    expect(client.createEdit(first, 'obsolete')).to.equal(null);
  });

  it('ignores mount-time normalization until the current editor receives user input', () => {
    const client = new WebviewDocumentClient();
    const scope = client.acceptContent({
      type: 'setContent',
      content: 'testing!\n',
      documentVersion: 1,
      fileName: 'document.md',
      sessionId: 'session-a',
      sessionRevision: 0,
      acknowledgedClientRevision: 0,
    });

    expect(client.createEdit(scope, 'testing!')).to.equal(null);
    expect(client.armEdits(scope)).to.equal(true);
    expect(client.createEdit(scope, 'testing! now')).to.deep.include({
      type: 'edit',
      content: 'testing! now',
      clientRevision: 1,
    });
  });
});
