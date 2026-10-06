import { expect } from 'chai';
import {
  DocumentRecoveryJournal,
  DocumentSession,
  DocumentSessionConflictError,
  createFileSystemDocumentTarget,
  type DocumentRecoveryStorage,
} from '../src/document/index.js';
import { MemoryFileSystemProvider } from '../src/filesystem/index.js';

class MemoryRecoveryStorage implements DocumentRecoveryStorage {
  private readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }
  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }
}

function scope(session: DocumentSession): { targetKey: string; generation: number } {
  const snapshot = session.getSnapshot();
  if (!snapshot.targetKey) throw new Error('Expected an active document target.');
  return { targetKey: snapshot.targetKey, generation: snapshot.generation };
}

describe('DocumentSession crash recovery integration', () => {
  for (const strategy of ['use-local', 'use-external'] as const) {
    it(`does not resurrect a resolved recovery draft after repeated restarts (${strategy})`, async () => {
      let now = 1_000;
      const journal = new DocumentRecoveryJournal(new MemoryRecoveryStorage(), {
        now: () => now++,
      });
      const provider = new MemoryFileSystemProvider('restarts', 'Restarts');
      provider.seedText('/draft.md', 'baseline');
      const target = createFileSystemDocumentTarget(provider, '/draft.md');
      const createSession = () =>
        new DocumentSession({ autoSaveEnabled: false, recoveryJournal: journal });
      const original = createSession();
      await original.transitionTo(target, 'baseline');
      original.edit('old unsaved draft', scope(original));

      // Simulate another app saving, then two launches interrupted before the
      // conflict is resolved. Each launch journals its own recovered copy.
      provider.seedText('/draft.md', 'newer saved file');
      await createSession().transitionTo(target, 'newer saved file');
      const restarted = createSession();
      const opened = await restarted.transitionTo(target, 'newer saved file');
      expect(opened.content).to.equal('old unsaved draft');
      expect(opened.status).to.equal('conflict');
      expect(opened.conflict?.recoveredDraft).to.equal(true);
      expect(journal.list(target.key)).to.have.length(3);
      expect(opened.conflict?.recoveredDraftCapturedAt).to.equal(
        Math.min(...journal.list(target.key).map((record) => record.updatedAt)),
      );

      await restarted.resolveConflict(strategy);
      expect(journal.list(target.key)).to.deep.equal([]);
      const expected = strategy === 'use-local' ? 'old unsaved draft' : 'newer saved file';
      expect(await provider.readFile('/draft.md')).to.equal(expected);
      const reopened = await createSession().transitionTo(target, expected);
      expect(reopened.status).to.equal('saved');
      expect(reopened.content).to.equal(expected);
    });
  }

  it('clears all recovered copies only after a successful save', async () => {
    const journal = new DocumentRecoveryJournal(new MemoryRecoveryStorage());
    let fail = true;
    const target = {
      key: 'repeated-recovery',
      async commit() {
        if (fail) throw new Error('disk full');
      },
    };
    const createSession = () =>
      new DocumentSession({ autoSaveEnabled: false, recoveryJournal: journal });
    const original = createSession();
    await original.transitionTo(target, 'baseline');
    original.edit('draft', scope(original));
    await createSession().transitionTo(target, 'baseline');
    const restarted = createSession();
    await restarted.transitionTo(target, 'baseline');
    try {
      await restarted.flush();
      expect.fail('Expected the save to fail');
    } catch (error: unknown) {
      expect(error).to.be.instanceOf(Error).with.property('message', 'disk full');
    }
    expect(journal.list(target.key)).to.have.length(3);
    fail = false;
    await restarted.flush();
    expect(journal.list(target.key)).to.deep.equal([]);
  });

  it('preserves distinct drafts and newer owner edits when resolving recovered copies', async () => {
    let now = 1_000;
    const journal = new DocumentRecoveryJournal(new MemoryRecoveryStorage(), { now: () => now++ });
    const target = { key: 'independent-drafts', commit: async () => ({}) };
    const createSession = () =>
      new DocumentSession({ autoSaveEnabled: false, recoveryJournal: journal });
    const independent = createSession();
    const original = createSession();
    await independent.transitionTo(target, 'baseline');
    await original.transitionTo(target, 'baseline');
    independent.edit('different draft', scope(independent));
    original.edit('recovered draft', scope(original));
    await createSession().transitionTo(target, 'external edit');
    const restarted = createSession();
    await restarted.transitionTo(target, 'external edit');
    original.edit('newer owner edit', scope(original));

    await restarted.resolveConflict('use-external');
    expect(journal.list(target.key).map((record) => record.content)).to.have.members([
      'different draft',
      'newer owner edit',
    ]);
  });

  it('retires every matching recovered copy when the file is already saved', async () => {
    const journal = new DocumentRecoveryJournal(new MemoryRecoveryStorage());
    const target = { key: 'saved-recovery', commit: async () => ({}) };
    const createSession = () =>
      new DocumentSession({ autoSaveEnabled: false, recoveryJournal: journal });
    const original = createSession();
    await original.transitionTo(target, 'baseline');
    original.edit('draft', scope(original));
    await createSession().transitionTo(target, 'baseline');

    // The file was saved, but the process ended before acknowledgement.
    const reopened = await createSession().transitionTo(target, 'draft');
    expect(reopened.status).to.equal('saved');
    expect(journal.list(target.key)).to.deep.equal([]);
  });

  it('preserves independent drafts when two windows reuse generation and revision numbers', async () => {
    const storage = new MemoryRecoveryStorage();
    const journal = new DocumentRecoveryJournal(storage);
    const first = new DocumentSession({ recoveryJournal: journal, autoSaveEnabled: false });
    const second = new DocumentSession({
      recoveryJournal: new DocumentRecoveryJournal(storage),
      autoSaveEnabled: false,
    });
    const target = { key: 'shared:document', commit: async () => ({}) };
    await first.transitionTo(target, 'baseline');
    await second.transitionTo(target, 'baseline');
    first.edit('first draft', scope(first));
    second.edit('second draft', scope(second));
    expect(journal.list(target.key).map((record) => record.content)).to.have.members([
      'first draft',
      'second draft',
    ]);
    await first.flush();
    expect(journal.list(target.key).map((record) => record.content)).to.deep.equal([
      'second draft',
    ]);
    const restarted = new DocumentSession({
      recoveryJournal: new DocumentRecoveryJournal(storage),
      autoSaveEnabled: false,
    });
    expect((await restarted.transitionTo(target, 'baseline')).content).to.equal('second draft');
    // The original window advances while its older draft is being recovered.
    second.edit('newer second draft', scope(second));
    await restarted.flush();
    expect(journal.list(target.key).map((record) => record.content)).to.deep.equal([
      'newer second draft',
    ]);
    await first.cancel();
    await restarted.cancel();
    expect(journal.lookup(target.key)?.content).to.equal('newer second draft');
    await second.cancel();
  });
  it('restores a draft only when the durable baseline still matches', async () => {
    const journal = new DocumentRecoveryJournal(new MemoryRecoveryStorage(), {
      now: () => 1_000,
    });
    const provider = new MemoryFileSystemProvider('recovery', 'Recovery');
    provider.seedText('/draft.md', 'persisted');
    const target = createFileSystemDocumentTarget(provider, '/draft.md');
    journal.write({
      targetKey: target.key,
      generation: 7,
      revision: 12,
      content: 'recovered draft',
      persistedContent: 'persisted',
    });

    const session = new DocumentSession({ autoSaveDelayMs: 60_000, recoveryJournal: journal });
    const opened = await session.transitionTo(target, 'persisted');

    expect(opened.content).to.equal('recovered draft');
    expect(opened.status).to.equal('dirty');
    expect(opened.generation).to.be.greaterThan(7);
    await session.flush('manual');
    expect(await provider.readFile('/draft.md')).to.equal('recovered draft');
    expect(journal.lookup(target.key)).to.equal(null);
  });

  it('surfaces a conflict when storage changed after the journal baseline', async () => {
    const journal = new DocumentRecoveryJournal(new MemoryRecoveryStorage(), {
      now: () => 2_000,
    });
    const provider = new MemoryFileSystemProvider('conflict', 'Conflict');
    provider.seedText('/draft.md', 'external edit');
    const target = createFileSystemDocumentTarget(provider, '/draft.md');
    journal.write({
      targetKey: target.key,
      generation: 2,
      revision: 5,
      content: 'crashed local draft',
      persistedContent: 'old baseline',
    });

    const session = new DocumentSession({ autoSaveDelayMs: 60_000, recoveryJournal: journal });
    const opened = await session.transitionTo(target, 'external edit');

    expect(opened.status).to.equal('conflict');
    expect(opened.content).to.equal('crashed local draft');
    expect(opened.conflict?.externalContent).to.equal('external edit');
    expect(opened.conflict?.recoveredDraft).to.equal(true);
    // An initial watcher observation must not turn recovery into an ordinary
    // live-edit conflict just because it supplies the file's version.
    session.observeExternal({ targetKey: target.key, content: 'external edit', version: 1 });
    expect(session.getSnapshot().conflict?.recoveredDraft).to.equal(true);
    let thrown: unknown;
    try {
      await session.flush('manual');
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).to.be.instanceOf(DocumentSessionConflictError);
    expect(await provider.readFile('/draft.md')).to.equal('external edit');

    await session.resolveConflict('use-external');
    expect(session.getSnapshot().content).to.equal('external edit');
    expect(journal.lookup(target.key)).to.equal(null);
  });

  it('keeps the synchronous draft after a failed save and clears it after retry', async () => {
    const journal = new DocumentRecoveryJournal(new MemoryRecoveryStorage(), {
      now: () => 3_000,
    });
    let fail = true;
    const session = new DocumentSession({ autoSaveDelayMs: 60_000, recoveryJournal: journal });
    await session.transitionTo(
      {
        key: 'failure:draft.md',
        async commit() {
          if (fail) throw new Error('disk full');
        },
      },
      'persisted',
    );
    session.edit('unsaved draft', scope(session));

    try {
      await session.flush('manual');
    } catch {
      // Expected: the record must survive the failed acknowledgement.
    }
    expect(journal.lookup('failure:draft.md')?.content).to.equal('unsaved draft');

    fail = false;
    await session.flush('manual');
    expect(journal.lookup('failure:draft.md')).to.equal(null);
  });
});
