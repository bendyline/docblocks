import { expect } from 'chai';
import type { WebviewToExtensionMessage } from '@bendyline/docblocks/vscode';
import { drainsAfterPanelDispose, EditorMessageQueue } from '../src/editorMessageQueue.js';

describe('VS Code editor close message queue', () => {
  it('drains an accepted edit behind a delayed operation while dropping queued privileged work', async () => {
    const handled: string[] = [];
    const errors: unknown[] = [];
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const queue = new EditorMessageQueue<WebviewToExtensionMessage>({
      maxPendingOperations: 8,
      maxPendingWireCharacters: 1_000,
      estimateWireCharacters: (message) => (message.type === 'edit' ? message.content.length : 0),
      drainAfterDispose: drainsAfterPanelDispose,
      onError: (error) => errors.push(error),
    });

    expect(
      queue.enqueue({ type: 'listMedia', requestId: 1 }, async () => {
        handled.push('active-media-started');
        markStarted?.();
        await firstCanFinish;
        handled.push('active-media-finished');
      }),
    ).to.equal(true);
    await started;

    expect(
      queue.enqueue(
        {
          type: 'edit',
          content: 'latest close-safe text',
          sessionId: 'session-a',
          clientRevision: 1,
          baseDocumentVersion: 1,
        },
        async () => {
          handled.push('queued-edit');
        },
      ),
    ).to.equal(true);
    expect(
      queue.enqueue({ type: 'removeMedia', requestId: 2, ref: 'image.png' }, async () => {
        handled.push('queued-media');
      }),
    ).to.equal(true);

    queue.beginDispose();
    expect(
      queue.enqueue(
        {
          type: 'edit',
          content: 'arrived after disposal',
          sessionId: 'session-a',
          clientRevision: 2,
          baseDocumentVersion: 1,
        },
        async () => {
          handled.push('late-edit');
        },
      ),
    ).to.equal(false);
    releaseFirst?.();
    await queue.drain();

    expect(handled).to.deep.equal(['active-media-started', 'active-media-finished', 'queued-edit']);
    expect(errors).to.deep.equal([]);
  });

  it('classifies only document lifecycle messages as close-critical', () => {
    expect(
      drainsAfterPanelDispose({
        type: 'edit',
        content: 'draft',
        sessionId: 'session-a',
        clientRevision: 1,
        baseDocumentVersion: 1,
      }),
    ).to.equal(true);
    expect(
      drainsAfterPanelDispose({
        type: 'save',
        sessionId: 'session-a',
        requestId: 1,
        clientRevision: 1,
        baseDocumentVersion: 1,
      }),
    ).to.equal(true);
    expect(
      drainsAfterPanelDispose({
        type: 'resolveConflict',
        sessionId: 'session-a',
        choice: 'use-local',
      }),
    ).to.equal(true);
    expect(drainsAfterPanelDispose({ type: 'listMedia', requestId: 1 })).to.equal(false);
  });
});
