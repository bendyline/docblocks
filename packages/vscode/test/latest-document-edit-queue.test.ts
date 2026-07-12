import { expect } from 'chai';
import {
  HostDocumentChangedError,
  VscodeDocumentSync,
  type HostDocumentAdapter,
  type HostDocumentSnapshot,
} from '../src/editSync.js';
import { EditorMessageQueue } from '../src/editorMessageQueue.js';
import { LatestDocumentEditQueue } from '../src/latestDocumentEditQueue.js';

class CloseTestAdapter implements HostDocumentAdapter {
  public readonly key = 'file:///workspace/saturated.md';
  public content = 'initial';
  public version = 1;

  public async read() {
    return { content: this.content, version: this.version };
  }

  public async replaceAndSave(content: string, expected: HostDocumentSnapshot) {
    const actual = await this.read();
    if (actual.version !== expected.version || actual.content !== expected.content) {
      throw new HostDocumentChangedError(actual);
    }
    this.content = content;
    this.version += 1;
    return this.read();
  }
}

describe('VS Code latest document edit ingress', () => {
  it('persists the latest coalesced snapshot when the privileged queue is saturated and closes', async () => {
    const adapter = new CloseTestAdapter();
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveDelayMs: 60_000,
      createSessionId: () => 'session-a',
    });
    const privilegedQueue = new EditorMessageQueue<string>({
      maxPendingOperations: 1,
      maxPendingWireCharacters: 1,
      estimateWireCharacters: () => 1,
      drainAfterDispose: () => false,
      onError: (error) => {
        throw error;
      },
    });
    let releasePrivileged: (() => void) | undefined;
    const privilegedBlocker = new Promise<void>((resolve) => {
      releasePrivileged = resolve;
    });
    expect(privilegedQueue.enqueue('blocking export', () => privilegedBlocker)).to.equal(true);
    expect(privilegedQueue.enqueue('queue is full', async () => undefined)).to.equal(false);

    let releaseFirstEdit: (() => void) | undefined;
    const firstEditBlocker = new Promise<void>((resolve) => {
      releaseFirstEdit = resolve;
    });
    let firstEdit = true;
    const errors: unknown[] = [];
    const latestEdits = new LatestDocumentEditQueue({
      apply: async (message) => {
        if (firstEdit) {
          firstEdit = false;
          await firstEditBlocker;
        }
        const acknowledgement = sync.acceptEdit(message);
        if (!acknowledgement.accepted) throw new Error(acknowledgement.message ?? 'edit rejected');
      },
      onError: (error) => errors.push(error),
    });

    const state = sync.getSnapshot();
    for (let revision = 1; revision <= 500; revision += 1) {
      expect(
        latestEdits.enqueue({
          type: 'edit',
          content: `snapshot ${revision}`,
          sessionId: state.sessionId,
          clientRevision: revision,
          baseDocumentVersion: state.baseDocumentVersion,
        }),
      ).to.equal(true);
    }

    // Simulate an immediate panel close: no new ingress is accepted, but the
    // already accepted latest snapshot must enter the session before close.
    latestEdits.beginDispose();
    privilegedQueue.beginDispose();
    releaseFirstEdit?.();
    releasePrivileged?.();
    await latestEdits.flush();
    await privilegedQueue.drain();
    await sync.prepareClose();

    expect(errors).to.deep.equal([]);
    expect(sync.getSnapshot().acknowledgedClientRevision).to.equal(500);
    expect(adapter.content).to.equal('snapshot 500');
    sync.dispose();
  });
});
