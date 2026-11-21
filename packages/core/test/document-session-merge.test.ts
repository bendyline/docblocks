import { expect } from 'chai';
import {
  createFileSystemDocumentTarget,
  DocumentCommitConflictError,
  DocumentSession,
  DocumentSessionConflictError,
  type DocumentCommitRequest,
  type DocumentCommitTarget,
  type DocumentParkRequest,
  type DocumentSessionEvent,
} from '../src/document/index.js';
import {
  conflictCopyScope,
  listConflictCopies,
  readConflictCopy,
} from '../src/filesystem/conflict-copies.js';
import { MemoryFileSystemProvider } from '../src/filesystem/memory-provider.js';
import { DocumentRecoveryJournal } from '../src/document/recovery-journal.js';

const doc = (...paragraphs: string[]) => paragraphs.join('\n\n') + '\n';
const BASE = doc('# Unicorns', 'They are rare.', 'They like rainbows.');
const LOCAL = doc('# Unicorns', 'They are rare.', 'They like rainbows and glitter.');
const EXTERNAL = doc('# Unicorns', 'They are very rare.', 'They like rainbows.');
const MERGED = doc('# Unicorns', 'They are very rare.', 'They like rainbows and glitter.');
const OVERLAP = doc('# Unicorns', 'They are rare.', 'They like rainbows, mostly.');

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await wait(5);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function edit(session: DocumentSession, content: string): number {
  const snapshot = session.getSnapshot();
  return session.edit(content, { targetKey: snapshot.targetKey!, generation: snapshot.generation });
}

interface Harness {
  session: DocumentSession;
  commits: DocumentCommitRequest[];
  parked: DocumentParkRequest[];
  events: DocumentSessionEvent[];
  target: DocumentCommitTarget;
}

async function open(
  options: {
    park?: boolean | ((request: DocumentParkRequest) => Promise<void>);
    commit?: (request: DocumentCommitRequest) => Promise<void>;
    idleMs?: number;
    autoMerge?: boolean;
  } = {},
): Promise<Harness> {
  const commits: DocumentCommitRequest[] = [];
  const parked: DocumentParkRequest[] = [];
  const events: DocumentSessionEvent[] = [];
  const session = new DocumentSession({
    autoSaveEnabled: false,
    autoMergeIdleMs: options.idleMs ?? 0,
    autoMergeEnabled: options.autoMerge,
  });
  session.subscribeEvents((event) => events.push(event));
  const target: DocumentCommitTarget = {
    key: 'workspace:unicorns.md',
    async commit(request) {
      commits.push(request);
      await options.commit?.(request);
    },
    ...(options.park === false
      ? {}
      : {
          async park(request: DocumentParkRequest) {
            parked.push(request);
            if (typeof options.park === 'function') await options.park(request);
          },
        }),
  };
  await session.transitionTo(target, BASE);
  return { session, commits, parked, events, target };
}

function observe(session: DocumentSession, content: string | null, sequence?: number) {
  return session.observeExternal({
    targetKey: 'workspace:unicorns.md',
    content,
    ...(sequence === undefined ? {} : { sequence }),
    origin: { savedBy: "Mike's MacBook Pro" },
  });
}

describe('DocumentSession automatic merge', () => {
  it('combines separate edits, keeps the text from before, saves, and says so', async () => {
    const { session, commits, parked, events } = await open();
    edit(session, LOCAL);
    const generation = session.getSnapshot().generation;

    expect(observe(session, EXTERNAL)).to.equal('conflict');
    expect(session.getSnapshot().conflict?.merging).to.equal(true);
    expect(session.getSnapshot().conflict?.baseContent).to.equal(BASE);

    await until(() => session.getSnapshot().status === 'saved', 'the merged save');
    const snapshot = session.getSnapshot();
    expect(snapshot.content).to.equal(MERGED);
    expect(snapshot.conflict).to.equal(null);
    expect(snapshot.generation).to.be.greaterThan(generation);
    expect(parked).to.deep.equal([
      {
        targetKey: 'workspace:unicorns.md',
        content: LOCAL,
        origin: 'premerge',
        currentContent: EXTERNAL,
      },
    ]);
    // The save is conditional on the outside version it merged with.
    expect(commits.at(-1)).to.include({ content: MERGED, persistedContent: EXTERNAL });
    expect(events).to.deep.equal([
      {
        type: 'merged',
        targetKey: 'workspace:unicorns.md',
        localContent: LOCAL,
        externalContent: EXTERNAL,
        mergedContent: MERGED,
        externalOrigin: { savedBy: "Mike's MacBook Pro" },
      },
    ]);
    await session.cancel();
  });

  it('asks the user when both sides changed the same paragraph', async () => {
    const { session, parked, events } = await open();
    edit(session, LOCAL);
    expect(observe(session, OVERLAP)).to.equal('conflict');
    await wait(20);
    const conflict = session.getSnapshot().conflict;
    expect(conflict?.merging).to.equal(undefined);
    expect(conflict).to.include({
      localContent: LOCAL,
      externalContent: OVERLAP,
      baseContent: BASE,
    });
    expect(conflict?.externalOrigin).to.deep.equal({ savedBy: "Mike's MacBook Pro" });
    expect(parked).to.deep.equal([]);
    expect(events).to.deep.equal([]);
    await session.cancel();
  });

  it('never merges for a target that cannot keep the earlier text, or when turned off', async () => {
    for (const options of [{ park: false as const }, { autoMerge: false }]) {
      const { session, commits } = await open(options);
      edit(session, LOCAL);
      expect(observe(session, EXTERNAL)).to.equal('conflict');
      await wait(20);
      expect(session.getSnapshot().conflict?.merging).to.equal(undefined);
      expect(session.getSnapshot().content).to.equal(LOCAL);
      expect(commits).to.deep.equal([]);
      await session.cancel();
    }
  });

  it('waits for typing to pause and merges what was typed meanwhile', async () => {
    const { session, parked } = await open({ idleMs: 60 });
    edit(session, LOCAL);
    observe(session, EXTERNAL);
    await wait(30);
    const later = doc('# Unicorns', 'They are rare.', 'They like rainbows, glitter and cake.');
    edit(session, later);
    await wait(30);
    // Still inside the pause measured from the latest keystroke.
    expect(session.getSnapshot().conflict?.merging).to.equal(true);
    expect(parked).to.deep.equal([]);

    await until(() => session.getSnapshot().status === 'saved', 'the merged save');
    expect(session.getSnapshot().content).to.equal(
      doc('# Unicorns', 'They are very rare.', 'They like rainbows, glitter and cake.'),
    );
    expect(parked.map((request) => request.content)).to.deep.equal([later]);
    await session.cancel();
  });

  it('stops planning a merge once typing makes the edits overlap', async () => {
    const { session, parked } = await open({ idleMs: 40 });
    edit(session, LOCAL);
    observe(session, EXTERNAL);
    expect(session.getSnapshot().conflict?.merging).to.equal(true);
    edit(session, doc('# Unicorns', 'They are rare indeed.', 'They like rainbows and glitter.'));
    expect(session.getSnapshot().conflict?.merging).to.equal(undefined);
    await wait(80);
    expect(session.getSnapshot().status).to.equal('conflict');
    expect(parked).to.deep.equal([]);
    await session.cancel();
  });

  it('follows a newer outside version that arrives before the merge', async () => {
    const { session } = await open({ idleMs: 40 });
    edit(session, LOCAL);
    observe(session, EXTERNAL, 1);
    const newer = doc('# Unicorns!', 'They are very rare.', 'They like rainbows.');
    observe(session, newer, 2);
    await until(() => session.getSnapshot().status === 'saved', 'the merged save');
    expect(session.getSnapshot().content).to.equal(
      doc('# Unicorns!', 'They are very rare.', 'They like rainbows and glitter.'),
    );
    await session.cancel();
  });

  it('asks the user when the earlier text cannot be kept', async () => {
    const { session, commits } = await open({
      park: async () => {
        throw new Error('disk full');
      },
    });
    edit(session, LOCAL);
    observe(session, EXTERNAL);
    await until(() => session.getSnapshot().conflict?.merging === undefined, 'the fallback');
    const snapshot = session.getSnapshot();
    expect(snapshot.status).to.equal('conflict');
    expect(snapshot.content).to.equal(LOCAL);
    expect(commits).to.deep.equal([]);
    await session.cancel();
  });

  it('merges when the conflict is first noticed by a save', async () => {
    let onDisk = BASE;
    const { session, commits } = await open({
      commit: async (request) => {
        if (onDisk !== request.persistedContent && onDisk !== request.content) {
          throw new DocumentCommitConflictError('changed', onDisk, 'v2');
        }
        onDisk = request.content;
      },
    });
    onDisk = EXTERNAL;
    edit(session, LOCAL);
    await session.flush().catch((error: unknown) => {
      expect(error).to.be.instanceOf(DocumentSessionConflictError);
    });
    await until(() => session.getSnapshot().status === 'saved', 'the merged save');
    expect(onDisk).to.equal(MERGED);
    expect(commits.map((commit) => commit.content)).to.deep.equal([LOCAL, MERGED]);
    await session.cancel();
  });

  /** A file that another program saves again just as the merged text is written. */
  function racingFile(again: string) {
    let onDisk = EXTERNAL;
    return {
      read: () => onDisk,
      commit: async (request: DocumentCommitRequest) => {
        if (onDisk === EXTERNAL) onDisk = again;
        if (onDisk !== request.persistedContent) {
          throw new DocumentCommitConflictError('changed', onDisk, 'v3');
        }
        onDisk = request.content;
      },
    };
  }

  it('merges again when the file changes elsewhere under the merged save', async () => {
    const again = doc('# Unicorns', 'They are extremely rare.', 'They like rainbows.');
    const file = racingFile(again);
    const { session, parked } = await open({ commit: file.commit });
    edit(session, LOCAL);
    observe(session, EXTERNAL);
    await until(() => session.getSnapshot().status === 'saved', 'the second merged save');
    expect(file.read()).to.equal(
      doc('# Unicorns', 'They are extremely rare.', 'They like rainbows and glitter.'),
    );
    // Each merge kept the text it replaced.
    expect(parked.map((request) => request.content)).to.deep.equal([LOCAL, MERGED]);
    await session.cancel();
  });

  it('asks the user when the file changes again in the paragraph being merged', async () => {
    const again = doc('# Unicorns', 'They are very rare.', 'They like rainbows, sometimes.');
    const { session } = await open({ commit: racingFile(again).commit });
    edit(session, LOCAL);
    observe(session, EXTERNAL);
    await until(
      () => session.getSnapshot().conflict?.externalContent === again,
      'the second conflict',
    );
    // The merged text is now the local side: nothing was lost, and nothing is planned.
    const conflict = session.getSnapshot().conflict;
    expect(conflict?.localContent).to.equal(MERGED);
    expect(conflict?.merging).to.equal(undefined);
    await session.cancel();
  });

  it('never merges a draft recovered from a previous session', async () => {
    const values = new Map<string, string>();
    const journal = new DocumentRecoveryJournal({
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    });
    const parked: DocumentParkRequest[] = [];
    const target: DocumentCommitTarget = {
      key: 'workspace:unicorns.md',
      commit: async () => {},
      park: async (request) => void parked.push(request),
    };
    const crashed = new DocumentSession({ autoSaveEnabled: false, recoveryJournal: journal });
    await crashed.transitionTo(target, BASE);
    edit(crashed, LOCAL);

    const reopened = new DocumentSession({
      autoSaveEnabled: false,
      autoMergeIdleMs: 0,
      recoveryJournal: journal,
    });
    await reopened.transitionTo(target, EXTERNAL);
    await wait(20);
    const conflict = reopened.getSnapshot().conflict;
    expect(conflict?.recoveredDraft).to.equal(true);
    expect(conflict?.merging).to.equal(undefined);
    expect(conflict?.baseContent).to.equal(BASE);
    expect(parked).to.deep.equal([]);
    await reopened.cancel();
    await crashed.cancel();
  });
});

describe('DocumentSession leaving a document with an open conflict', () => {
  it('sets the unsaved text aside and takes the saved file, so navigation goes ahead', async () => {
    const { session, parked, events, commits } = await open();
    edit(session, LOCAL);
    observe(session, OVERLAP);

    const next = await session.transitionTo(
      { key: 'workspace:other.md', commit: async () => {} },
      'other',
    );
    expect(next.targetKey).to.equal('workspace:other.md');
    expect(next.conflict).to.equal(null);
    expect(parked).to.deep.equal([
      {
        targetKey: 'workspace:unicorns.md',
        content: LOCAL,
        origin: 'local',
        currentContent: OVERLAP,
      },
    ]);
    expect(events).to.deep.equal([
      { type: 'parked', targetKey: 'workspace:unicorns.md', origin: 'local' },
    ]);
    // The losing text was never written over the saved file.
    expect(commits).to.deep.equal([]);
    await session.cancel();
  });

  it('finishes a planned merge instead of setting text aside', async () => {
    const { session, parked, commits } = await open({ idleMs: 10_000 });
    edit(session, LOCAL);
    observe(session, EXTERNAL);
    await session.transitionTo({ key: 'workspace:other.md', commit: async () => {} }, 'other');
    expect(parked.map((request) => request.origin)).to.deep.equal(['premerge']);
    expect(commits.at(-1)?.content).to.equal(MERGED);
    await session.cancel();
  });

  it('still blocks when the file was deleted, or the target cannot keep the text', async () => {
    const deleted = await open();
    edit(deleted.session, LOCAL);
    observe(deleted.session, null);
    let error: unknown;
    try {
      await deleted.session.transitionTo(null, '');
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).to.be.instanceOf(DocumentSessionConflictError);
    expect(deleted.parked).to.deep.equal([]);
    await deleted.session.cancel();

    const plain = await open({ park: false });
    edit(plain.session, LOCAL);
    observe(plain.session, OVERLAP);
    error = undefined;
    try {
      await plain.session.transitionTo(null, '');
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).to.be.instanceOf(DocumentSessionConflictError);
    expect(plain.session.getSnapshot().content).to.equal(LOCAL);
    await plain.session.cancel();
  });

  it('keeps the conflict and stays put when the text cannot be set aside', async () => {
    const { session } = await open({
      park: async () => {
        throw new Error('disk full');
      },
    });
    edit(session, LOCAL);
    observe(session, OVERLAP);
    let failed = false;
    try {
      await session.transitionTo(null, '');
    } catch {
      failed = true;
    }
    expect(failed).to.equal(true);
    const snapshot = session.getSnapshot();
    expect(snapshot.targetKey).to.equal('workspace:unicorns.md');
    expect(snapshot.conflict?.localContent).to.equal(LOCAL);
    expect(snapshot.lifecycle).to.equal('open');
    await session.cancel();
  });

  it('sets text aside when the window closes', async () => {
    const { session, parked } = await open();
    edit(session, LOCAL);
    observe(session, OVERLAP);
    const closing = await session.prepareClose();
    expect(closing.lifecycle).to.equal('closing');
    expect(closing.conflict).to.equal(null);
    expect(parked.map((request) => request.origin)).to.deep.equal(['local']);
    await session.cancel();
  });

  it('keeps parked text as a conflict copy beside a real Markdown document', async () => {
    const fs = new MemoryFileSystemProvider('park-copies', 'Park');
    await fs.writeFile('Notes/Unicorns.md', BASE);
    const session = new DocumentSession({ autoSaveEnabled: false, autoMergeIdleMs: 0 });
    await session.transitionTo(createFileSystemDocumentTarget(fs, 'Notes/Unicorns.md'), BASE);
    edit(session, LOCAL);
    await fs.writeFile('Notes/Unicorns.md', OVERLAP);
    await session.flush().catch(() => undefined);
    expect(session.getSnapshot().status).to.equal('conflict');

    await session.transitionTo(null, '');
    const scope = conflictCopyScope('Notes/Unicorns.md')!;
    const copies = await listConflictCopies(fs, scope);
    expect(copies.map((copy) => copy.origin)).to.deep.equal(['local']);
    expect(await readConflictCopy(fs, copies[0]!)).to.equal(LOCAL);
    expect(await fs.readFile('Notes/Unicorns.md')).to.equal(OVERLAP);
    await session.cancel();
    await fs.v2.dispose();
  });

  it('merges on a real file and keeps the earlier text for undo', async () => {
    const fs = new MemoryFileSystemProvider('merge-copies', 'Merge');
    await fs.writeFile('Unicorns.md', BASE);
    const session = new DocumentSession({ autoSaveEnabled: false, autoMergeIdleMs: 0 });
    await session.transitionTo(createFileSystemDocumentTarget(fs, 'Unicorns.md'), BASE);
    edit(session, LOCAL);
    await fs.writeFile('Unicorns.md', EXTERNAL);
    await session.flush().catch(() => undefined);
    await until(() => session.getSnapshot().status === 'saved', 'the merged save');
    expect(await fs.readFile('Unicorns.md')).to.equal(MERGED);
    const copies = await listConflictCopies(fs, conflictCopyScope('Unicorns.md')!);
    expect(copies.map((copy) => copy.origin)).to.deep.equal(['premerge']);
    expect(await readConflictCopy(fs, copies[0]!)).to.equal(LOCAL);
    await session.cancel();
    await fs.v2.dispose();
  });

  it('offers no parking for a file that keeps no sidecar', async () => {
    const fs = new MemoryFileSystemProvider('no-park', 'No park');
    expect(createFileSystemDocumentTarget(fs, 'data.json').park).to.equal(undefined);
    expect(createFileSystemDocumentTarget(fs, 'notes.md').park).to.be.a('function');
    expect(
      createFileSystemDocumentTarget(fs, 'notes.md', { keepConflictCopies: false }).park,
    ).to.equal(undefined);
    await fs.v2.dispose();
  });
});

describe('DocumentSession explicit choices', () => {
  it('saves a hand-merged version over the outside one and remounts the editor', async () => {
    const { session, commits } = await open();
    edit(session, LOCAL);
    observe(session, OVERLAP);
    const generation = session.getSnapshot().generation;
    const chosen = doc('# Unicorns', 'They are rare.', 'They like rainbows and glitter, mostly.');
    const resolved = await session.resolveConflict('use-merged', { content: chosen });
    expect(resolved.status).to.equal('saved');
    expect(resolved.content).to.equal(chosen);
    expect(resolved.generation).to.be.greaterThan(generation);
    expect(commits.at(-1)).to.include({ content: chosen, persistedContent: OVERLAP });

    let error: unknown;
    edit(session, LOCAL);
    observe(session, EXTERNAL.replace('very', 'somewhat') + 'x');
    try {
      await session.resolveConflict('use-merged');
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).to.be.instanceOf(TypeError);
    await session.cancel();
  });

  it('replaces the document with a chosen version and saves it', async () => {
    const { session, commits } = await open();
    const generation = session.getSnapshot().generation;
    const replaced = await session.replaceContent(EXTERNAL);
    expect(replaced.status).to.equal('saved');
    expect(replaced.content).to.equal(EXTERNAL);
    expect(replaced.generation).to.be.greaterThan(generation);
    expect(commits.at(-1)).to.include({ content: EXTERNAL, persistedContent: BASE });
    // The same text again is nothing to do.
    await session.replaceContent(EXTERNAL);
    expect(commits).to.have.length(1);
    await session.cancel();
  });

  it('refuses to replace a document whose conflict is open', async () => {
    const { session } = await open({ park: false });
    edit(session, LOCAL);
    observe(session, OVERLAP);
    let error: unknown;
    try {
      await session.replaceContent('anything');
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).to.be.instanceOf(DocumentSessionConflictError);
    expect(session.getSnapshot().content).to.equal(LOCAL);
    await session.cancel();
  });

  it('says when a clean document took a newer version saved elsewhere', async () => {
    const { session, events } = await open();
    expect(observe(session, EXTERNAL)).to.equal('applied');
    expect(events).to.deep.equal([
      {
        type: 'external-applied',
        targetKey: 'workspace:unicorns.md',
        externalOrigin: { savedBy: "Mike's MacBook Pro" },
      },
    ]);
    await session.cancel();
  });
});

describe('DocumentSession autosave pacing', () => {
  async function paced(pacing: { delayMs: number; maxWaitMs?: number | null }) {
    const commits: string[] = [];
    const session = new DocumentSession({ autoSaveDelayMs: 500 });
    await session.transitionTo(
      { key: 'workspace:paced.md', commit: async (request) => void commits.push(request.content) },
      'initial',
    );
    session.setAutoSavePacing(pacing);
    return { session, commits };
  }

  it('waits for the configured pause after the last edit', async () => {
    const { session, commits } = await paced({ delayMs: 60 });
    edit(session, 'one');
    await wait(30);
    edit(session, 'two');
    await wait(40);
    // 70 ms after the first edit, but only 40 ms after the last.
    expect(commits).to.deep.equal([]);
    await until(() => commits.length === 1, 'the save');
    expect(commits).to.deep.equal(['two']);
    await session.cancel();
  });

  it('saves during steady typing once the limit is reached', async () => {
    const { session, commits } = await paced({ delayMs: 80, maxWaitMs: 150 });
    // An edit every 40 ms never leaves an 80 ms pause.
    for (let index = 0; index < 8; index += 1) {
      edit(session, `typing ${index}`);
      await wait(40);
    }
    expect(commits.length, 'saved while still typing').to.be.greaterThan(0);
    await until(() => session.getSnapshot().status === 'saved', 'the final save');
    expect(commits.at(-1)).to.equal('typing 7');
    await session.cancel();
  });

  it('never saves during steady typing without a limit', async () => {
    const { session, commits } = await paced({ delayMs: 80 });
    for (let index = 0; index < 6; index += 1) {
      edit(session, `typing ${index}`);
      await wait(40);
    }
    expect(commits).to.deep.equal([]);
    await until(() => commits.length === 1, 'the save');
    await session.cancel();
  });

  it('starts the limit again for edits made after a save', async () => {
    const { session, commits } = await paced({ delayMs: 30, maxWaitMs: 1_000 });
    edit(session, 'first');
    await until(() => commits.length === 1, 'the first save');
    await wait(60);
    edit(session, 'second');
    // The limit counts from this edit, not from the long-saved first one,
    // so the ordinary pause still applies.
    await wait(10);
    expect(commits).to.deep.equal(['first']);
    await until(() => commits.length === 2, 'the second save');
    await session.cancel();
  });

  it('rejects pacing that is not a sensible time', async () => {
    const { session } = await paced({ delayMs: 10 });
    expect(() => session.setAutoSavePacing({ delayMs: -1 })).to.throw(TypeError);
    expect(() => session.setAutoSavePacing({ delayMs: Number.NaN })).to.throw(TypeError);
    expect(() => session.setAutoSavePacing({ delayMs: 10, maxWaitMs: -5 })).to.throw(TypeError);
    await session.cancel();
  });
});
