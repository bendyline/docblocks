import { expect } from 'chai';
import {
  DOCUMENT_RECOVERY_JOURNAL_SCHEMA_VERSION,
  DOCUMENT_RECOVERY_JOURNAL_STORAGE_KEY,
  DocumentRecoveryJournal,
  type DocumentRecoveryRecord,
  type DocumentRecoveryStorage,
} from '../src/document/recovery-journal.js';

class FakeStorage implements DocumentRecoveryStorage {
  public readonly values = new Map<string, string>();
  public failReads = false;
  public failWrites = 0;
  public alwaysFailWrites = false;

  public getItem(key: string): string | null {
    if (this.failReads) throw new Error('storage read denied');
    return this.values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    if (this.alwaysFailWrites || this.failWrites > 0) {
      this.failWrites = Math.max(0, this.failWrites - 1);
      throw new Error('quota exceeded');
    }
    this.values.set(key, value);
  }

  public removeItem(key: string): void {
    if (this.alwaysFailWrites) throw new Error('storage write denied');
    this.values.delete(key);
  }
}

interface MutableClock {
  now: () => number;
  advance(ms: number): void;
}

function mutableClock(initial = 1_000): MutableClock {
  let value = initial;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

function writeDraft(
  journal: DocumentRecoveryJournal,
  targetKey: string,
  generation: number,
  revision: number,
  content: string,
  persistedContent: string | null = 'baseline',
) {
  return journal.write({ targetKey, generation, revision, content, persistedContent });
}

function storedRecord(overrides: Partial<DocumentRecoveryRecord> = {}): DocumentRecoveryRecord {
  return {
    targetKey: 'workspace:/doc.md',
    generation: 1,
    revision: 2,
    content: 'draft',
    persistedContent: 'baseline',
    createdAt: 900,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('DocumentRecoveryJournal', () => {
  it('synchronously stores and retrieves a scoped draft with its persisted baseline', () => {
    const storage = new FakeStorage();
    const clock = mutableClock();
    const journal = new DocumentRecoveryJournal(storage, { now: clock.now });

    expect(writeDraft(journal, 'workspace:/doc.md', 3, 7, 'dirty', 'saved')).to.deep.equal({
      status: 'stored',
      evicted: 0,
    });

    const recovered = journal.lookup('workspace:/doc.md');
    expect(recovered).to.deep.include({
      targetKey: 'workspace:/doc.md',
      generation: 3,
      revision: 7,
      content: 'dirty',
      persistedContent: 'saved',
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(storage.values.has(DOCUMENT_RECOVERY_JOURNAL_STORAGE_KEY)).to.equal(true);
  });

  it('returns defensive copies from lookup and list', () => {
    const journal = new DocumentRecoveryJournal(new FakeStorage(), { now: () => 1_000 });
    writeDraft(journal, 'workspace:/doc.md', 1, 1, 'dirty');

    const recovered = journal.lookup('workspace:/doc.md');
    expect(recovered).not.to.equal(null);
    recovered!.content = 'mutated by caller';

    expect(journal.lookup('workspace:/doc.md')?.content).to.equal('dirty');
    expect(journal.list()[0]).not.to.equal(journal.list()[0]);
  });

  it('ignores older generations and revisions and rejects revision reuse with new content', () => {
    const journal = new DocumentRecoveryJournal(new FakeStorage(), { now: () => 1_000 });
    expect(writeDraft(journal, 'workspace:/doc.md', 2, 5, 'latest').status).to.equal('stored');

    expect(writeDraft(journal, 'workspace:/doc.md', 2, 4, 'old revision').status).to.equal(
      'ignored-stale',
    );
    expect(writeDraft(journal, 'workspace:/doc.md', 1, 99, 'old generation').status).to.equal(
      'ignored-stale',
    );
    expect(writeDraft(journal, 'workspace:/doc.md', 2, 5, 'ambiguous').status).to.equal('rejected');
    expect(writeDraft(journal, 'workspace:/doc.md', 2, 5, 'latest').status).to.equal('unchanged');
    expect(writeDraft(journal, 'workspace:/doc.md', 3, 0, 'next generation').status).to.equal(
      'stored',
    );
    expect(journal.lookup('workspace:/doc.md')?.content).to.equal('next generation');
  });

  it('clears only after the matching generation acknowledges the journaled revision', () => {
    const storage = new FakeStorage();
    const journal = new DocumentRecoveryJournal(storage, { now: () => 1_000 });
    writeDraft(journal, 'workspace:/doc.md', 4, 9, 'dirty');

    expect(
      journal.acknowledge({
        targetKey: 'workspace:/doc.md',
        generation: 3,
        persistedRevision: 99,
      }),
    ).to.equal(false);
    expect(
      journal.acknowledge({
        targetKey: 'workspace:/doc.md',
        generation: 4,
        persistedRevision: 8,
      }),
    ).to.equal(false);
    expect(journal.lookup('workspace:/doc.md')).not.to.equal(null);

    expect(
      journal.acknowledge({
        targetKey: 'workspace:/doc.md',
        generation: 4,
        persistedRevision: 9,
      }),
    ).to.equal(true);
    expect(journal.lookup('workspace:/doc.md')).to.equal(null);
    expect(storage.values.has(DOCUMENT_RECOVERY_JOURNAL_STORAGE_KEY)).to.equal(false);
  });

  it('supports generation-scoped lookup and explicit discard', () => {
    const journal = new DocumentRecoveryJournal(new FakeStorage(), { now: () => 1_000 });
    writeDraft(journal, 'workspace:/doc.md', 5, 2, 'dirty');

    expect(journal.lookup('workspace:/doc.md', 4)).to.equal(null);
    expect(journal.lookup('workspace:/doc.md', 5)?.content).to.equal('dirty');
    expect(journal.discard('workspace:/doc.md', 4)).to.equal(false);
    expect(journal.discard('workspace:/doc.md', 5)).to.equal(true);
    expect(journal.lookup('workspace:/doc.md')).to.equal(null);
  });

  it('lists records newest first and can filter by target', () => {
    const clock = mutableClock();
    const journal = new DocumentRecoveryJournal(new FakeStorage(), { now: clock.now });
    writeDraft(journal, 'workspace:/first.md', 0, 1, 'first');
    clock.advance(1);
    writeDraft(journal, 'workspace:/second.md', 0, 1, 'second');

    expect(journal.list().map((record) => record.targetKey)).to.deep.equal([
      'workspace:/second.md',
      'workspace:/first.md',
    ]);
    expect(journal.list('workspace:/first.md').map((record) => record.content)).to.deep.equal([
      'first',
    ]);
  });

  it('removes corrupt JSON without throwing', () => {
    const storage = new FakeStorage();
    storage.values.set(DOCUMENT_RECOVERY_JOURNAL_STORAGE_KEY, '{not json');
    const journal = new DocumentRecoveryJournal(storage, { now: () => 1_000 });

    expect(journal.list()).to.deep.equal([]);
    expect(storage.values.has(DOCUMENT_RECOVERY_JOURNAL_STORAGE_KEY)).to.equal(false);
  });

  it('filters stale, future-dated, malformed, oversized, and duplicate records', () => {
    const storage = new FakeStorage();
    const envelope = {
      schemaVersion: DOCUMENT_RECOVERY_JOURNAL_SCHEMA_VERSION,
      records: [
        storedRecord({ targetKey: 'valid', content: 'older duplicate', revision: 1 }),
        storedRecord({ targetKey: 'valid', content: 'winner', revision: 2, updatedAt: 1_010 }),
        storedRecord({ targetKey: 'stale', createdAt: 1, updatedAt: 1 }),
        storedRecord({ targetKey: 'future', createdAt: 2_000, updatedAt: 2_000 }),
        { ...storedRecord({ targetKey: 'malformed' }), revision: -1 },
        storedRecord({ targetKey: 'oversized', content: 'x'.repeat(1_000) }),
      ],
    };
    storage.values.set(DOCUMENT_RECOVERY_JOURNAL_STORAGE_KEY, JSON.stringify(envelope));
    const journal = new DocumentRecoveryJournal(storage, {
      now: () => 1_020,
      maxAgeMs: 100,
      maxFutureSkewMs: 10,
      maxRecordBytes: 500,
    });

    expect(journal.list().map((record) => [record.targetKey, record.content])).to.deep.equal([
      ['valid', 'winner'],
    ]);
    const repaired = JSON.parse(storage.values.get(DOCUMENT_RECOVERY_JOURNAL_STORAGE_KEY)!) as {
      records: DocumentRecoveryRecord[];
    };
    expect(repaired.records).to.have.length(1);
    expect(repaired.records[0].targetKey).to.equal('valid');
  });

  it('evicts the oldest records to enforce the configured entry bound', () => {
    const clock = mutableClock();
    const journal = new DocumentRecoveryJournal(new FakeStorage(), {
      now: clock.now,
      maxEntries: 2,
    });
    writeDraft(journal, 'first', 0, 1, 'one');
    clock.advance(1);
    writeDraft(journal, 'second', 0, 1, 'two');
    clock.advance(1);
    const result = writeDraft(journal, 'third', 0, 1, 'three');

    expect(result).to.deep.equal({ status: 'stored', evicted: 1 });
    expect(journal.list().map((record) => record.targetKey)).to.deep.equal(['third', 'second']);
  });

  it('rejects one oversized record without disturbing existing recovery data', () => {
    const storage = new FakeStorage();
    const journal = new DocumentRecoveryJournal(storage, {
      now: () => 1_000,
      maxRecordBytes: 500,
      maxStorageBytes: 2_000,
    });
    writeDraft(journal, 'small', 0, 1, 'safe');

    expect(writeDraft(journal, 'huge', 0, 1, 'x'.repeat(1_000))).to.deep.equal({
      status: 'rejected',
      reason: 'record-too-large',
      evicted: 0,
    });
    expect(journal.list().map((record) => record.targetKey)).to.deep.equal(['small']);
  });

  it('retries quota failure after evicting an older record', () => {
    const storage = new FakeStorage();
    const clock = mutableClock();
    const journal = new DocumentRecoveryJournal(storage, { now: clock.now });
    writeDraft(journal, 'old', 0, 1, 'old');
    clock.advance(1);
    storage.failWrites = 1;

    expect(writeDraft(journal, 'current', 0, 1, 'current')).to.deep.equal({
      status: 'stored',
      evicted: 1,
    });
    expect(journal.list().map((record) => record.targetKey)).to.deep.equal(['current']);
  });

  it('reports unavailable and exhausted storage without throwing', () => {
    const unavailable = new DocumentRecoveryJournal(null, { now: () => 1_000 });
    expect(writeDraft(unavailable, 'doc', 0, 1, 'dirty')).to.deep.equal({
      status: 'rejected',
      reason: 'storage-unavailable',
      evicted: 0,
    });
    expect(unavailable.list()).to.deep.equal([]);

    const storage = new FakeStorage();
    storage.alwaysFailWrites = true;
    const exhausted = new DocumentRecoveryJournal(storage, { now: () => 1_000 });
    expect(writeDraft(exhausted, 'doc', 0, 1, 'dirty')).to.deep.equal({
      status: 'rejected',
      reason: 'quota-exceeded',
      evicted: 0,
    });
    expect(exhausted.discard('doc')).to.equal(false);
  });

  it('supports an injected storage key and clock', () => {
    const storage = new FakeStorage();
    const journal = new DocumentRecoveryJournal(storage, {
      storageKey: 'custom:journal',
      now: () => 42,
    });
    writeDraft(journal, 'doc', 0, 1, 'dirty', null);

    expect(storage.values.has('custom:journal')).to.equal(true);
    expect(journal.lookup('doc')).to.deep.include({
      createdAt: 42,
      updatedAt: 42,
      persistedContent: null,
    });
  });
});
