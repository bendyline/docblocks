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
