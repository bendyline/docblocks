import { expect } from 'chai';
import { prepareHostLifecycle } from '../src/DocBlocksShell/host-lifecycle.js';
import { DocumentSession } from '../../core/src/document/document-session.js';

describe('mobile document lifecycle', () => {
  it('persists suspension edits and accepts another edit after resume', async () => {
    const commits: string[] = [];
    const session = new DocumentSession({ autoSaveEnabled: false });
    await session.transitionTo(
      {
        key: 'device:note.md',
        commit: async ({ content }) => {
          commits.push(content);
        },
      },
      'initial',
    );
    const scope = { targetKey: 'device:note.md', generation: session.getSnapshot().generation };
    session.edit('before suspension', scope);
    const result = await prepareHostLifecycle(session, {
      requestId: 'background',
      reason: 'app-background',
      deadline: Date.now() + 1000,
    });
    expect(result).to.deep.equal({
      status: 'ready',
      persistedRevision: session.getSnapshot().revision,
    });
    session.edit('after resume', scope);
    await session.flush();
    expect(commits).to.deep.equal(['before suspension', 'after resume']);
    expect(session.getSnapshot().status).to.equal('saved');
  });
  it('keeps an unfinished save dirty at the deadline and never freezes a later edit', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const commits: string[] = [];
    const session = new DocumentSession({ autoSaveEnabled: false });
    await session.transitionTo(
      {
        key: 'device:note.md',
        commit: async ({ content }) => {
          commits.push(content);
          await pending;
        },
      },
      'initial',
    );
    const scope = { targetKey: 'device:note.md', generation: session.getSnapshot().generation };
    session.edit('pending', scope);
    const result = await prepareHostLifecycle(session, {
      requestId: 'background',
      reason: 'app-background',
      deadline: Date.now() + 10,
    });
    expect(result.status).to.equal('blocked');
    expect(session.getSnapshot().persistedRevision).to.be.lessThan(session.getSnapshot().revision);
    session.edit('resumed while the old save is pending', scope);
    finish();
    await session.flush();
    expect(commits).to.deep.equal(['pending', 'resumed while the old save is pending']);
    expect(session.getSnapshot().status).to.equal('saved');
  });
});
