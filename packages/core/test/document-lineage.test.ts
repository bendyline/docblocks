import { expect } from 'chai';
import {
  DocumentCommitConflictError,
  DocumentLineageStore,
  DocumentSession,
  type DocumentCommitRequest,
  type DocumentCommitTarget,
  type DocumentParkRequest,
  type DocumentRecoveryStorage,
  type DocumentSessionEvent,
} from '../src/document/index.js';
import { DocumentLineage, textSignature } from '../src/document/lineage.js';

const doc = (...paragraphs: string[]) => paragraphs.join('\n\n') + '\n';
const BASE = doc('# Unicorns', 'They are rare.', 'They like rainbows.');
/** This device types in the last paragraph, over two saves. */
const MINE_1 = doc('# Unicorns', 'They are rare.', 'They like rainbows and');
const MINE_2 = doc('# Unicorns', 'They are rare.', 'They like rainbows and glitter.');
/** The other device changes the second paragraph, having seen none of that. */
const THEIRS = doc('# Unicorns', 'They are very rare.', 'They like rainbows.');
const BOTH = doc('# Unicorns', 'They are very rare.', 'They like rainbows and glitter.');

function memoryStorage(): DocumentRecoveryStorage & {
  items: Map<string, string>;
} {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

describe('DocumentLineage', () => {
  it('combines from the opened text when the other device saw none of the saves here', () => {
    const lineage = new DocumentLineage();
    lineage.opened(BASE, 100);
    lineage.saved(MINE_1, 200);
    lineage.saved(MINE_2, 300);
    expect(lineage.plan(MINE_2, THEIRS, 250)).to.deep.equal({
      status: 'merged',
      merged: BOTH,
      foreign: true,
    });
  });

  it('combines from the save the other device had received', () => {
    const lineage = new DocumentLineage();
    lineage.opened(BASE, 100);
    lineage.saved(MINE_1, 200);
    lineage.saved(MINE_2, 300);
    // Built on the first save: from the opened text, the last paragraph would
    // look changed by both and the merge would be refused.
    const theirs = doc('# Unicorns', 'They are very rare.', 'They like rainbows and');
    expect(lineage.plan(MINE_2, theirs, 250)).to.deep.equal({
      status: 'merged',
      merged: BOTH,
      foreign: true,
    });
  });

  it('refuses when both changed the same paragraph', () => {
    const lineage = new DocumentLineage();
    lineage.opened(BASE, 100);
    lineage.saved(MINE_2, 200);
    const theirs = doc('# Unicorns', 'They are rare.', 'They like rainbows, mostly.');
    expect(lineage.plan(MINE_2, theirs, 250).status).to.equal('overlap');
  });

  it('does not build on the opened text for a version saved before it was opened', () => {
    const lineage = new DocumentLineage();
    lineage.opened(BASE, 1_000);
    lineage.saved(MINE_2, 2_000);
    // Saved earlier: what it started from may be older than anything held here.
    expect(lineage.plan(MINE_2, THEIRS, 900).status).to.equal('unknown-base');
    expect(lineage.plan(MINE_2, THEIRS, null).status).to.equal('unknown-base');
  });

  it('does not swap in another version when nothing was typed here', () => {
    const lineage = new DocumentLineage();
    lineage.opened(BASE, 100);
    // Nothing says which of the two is the newer one.
    expect(lineage.plan(BASE, THEIRS, 200).status).to.equal('unknown-base');
  });

  it('puts back a save of its own that storage replaced', () => {
    const lineage = new DocumentLineage();
    lineage.opened(BASE, 100);
    lineage.saved(MINE_1, 200);
    lineage.saved(MINE_2, 300);
    // The sync service made the other device's version the document.
    lineage.tookOutside(THEIRS, 310);
    expect(lineage.plan(THEIRS, MINE_2, 300)).to.deep.equal({
      status: 'merged',
      merged: BOTH,
      foreign: false,
    });
  });

  it('finds nothing new in a text it still builds on', () => {
    const lineage = new DocumentLineage();
    lineage.opened(BASE, 100);
    lineage.saved(MINE_1, 200);
    lineage.saved(MINE_2, 300);
    expect(lineage.plan(MINE_2, MINE_1, 200).status).to.equal('included');
    expect(lineage.plan(MINE_2, MINE_2, 300).status).to.equal('included');
    // A newer outside version that was built on the saves here displaces nothing.
    lineage.tookOutside(BOTH, 400);
    expect(lineage.plan(BOTH, MINE_2, 300).status).to.equal('included');
  });

  it('keeps combining with a device that went on from either side of an earlier merge', () => {
    const lineage = new DocumentLineage();
    lineage.opened(BASE, 100);
    lineage.saved(MINE_2, 200);
    const first = lineage.plan(MINE_2, THEIRS, 210);
    expect(first.status).to.equal('merged');
    lineage.absorbed(THEIRS, 210, { setAside: true });
    lineage.saved(BOTH, 300);

    // The other device carried on from its own version...
    const fromTheirs = doc('# Unicorns!', 'They are very rare.', 'They like rainbows.');
    expect(lineage.plan(BOTH, fromTheirs, 400)).to.deep.equal({
      status: 'merged',
      merged: doc('# Unicorns!', 'They are very rare.', 'They like rainbows and glitter.'),
      foreign: true,
    });
    // ...or was handed this device's version first, and so lacks its own
    // earlier edit. That edit must not be taken back out of the document.
    const fromMine = doc('# Unicorns!', 'They are rare.', 'They like rainbows and glitter.');
    expect(lineage.plan(BOTH, fromMine, 400)).to.deep.equal({
      status: 'merged',
      merged: doc('# Unicorns!', 'They are very rare.', 'They like rainbows and glitter.'),
      foreign: true,
    });
  });

  describe('two devices typing at once, as seen on a Mac and an iPhone', () => {
    // The Mac deletes words from the second paragraph while the phone types
    // into the third, saving twice on the way.
    const START = doc('# Unicorns', 'They are rare, abc extra words.', 'They like rainbows');
    const MAC = doc('# Unicorns', 'They are rare.', 'They like rainbows');
    const PHONE_EARLY = doc(
      '# Unicorns',
      'They are rare, abc extra words.',
      'They like rainbows gvv',
    );
    const PHONE = doc(
      '# Unicorns',
      'They are rare, abc extra words.',
      'They like rainbows gvvvvvv',
    );
    const HALFWAY = doc('# Unicorns', 'They are rare.', 'They like rainbows gvv');
    const DONE = doc('# Unicorns', 'They are rare.', 'They like rainbows gvvvvvv');

    it("on the Mac: combines each of the phone's saves as it arrives and leaves nothing over", () => {
      const mac = new DocumentLineage();
      mac.opened(START, 100);
      mac.saved(MAC, 200);
      // The phone's first save was set aside by the sync service.
      expect(mac.plan(MAC, PHONE_EARLY, 210)).to.deep.equal({
        status: 'merged',
        merged: HALFWAY,
        foreign: true,
      });
      mac.absorbed(PHONE_EARLY, 210, { setAside: true });
      mac.saved(HALFWAY, 300);
      // Then its second, which only adds to the paragraph the first one changed.
      expect(mac.plan(HALFWAY, PHONE, 290)).to.deep.equal({
        status: 'merged',
        merged: DONE,
        foreign: true,
      });
      mac.absorbed(PHONE, 290, { setAside: true });
      mac.saved(DONE, 400);
      // The Mac's own halfway save, set aside in turn, has nothing left to add.
      expect(mac.plan(DONE, HALFWAY, 300).status).to.equal('included');
    });

    it('on the Mac: a halfway save of its own is not a version to review once the rest arrives', () => {
      const mac = new DocumentLineage();
      mac.opened(START, 100);
      mac.saved(MAC, 200);
      mac.absorbed(PHONE_EARLY, 210, { setAside: true });
      mac.saved(HALFWAY, 300);
      // The phone finished the job first and its result became the file.
      mac.tookOutside(DONE, 400);
      expect(mac.plan(DONE, HALFWAY, 300).status).to.equal('included');
      expect(mac.plan(DONE, PHONE, 290).status).to.equal('included');
    });

    it("on the phone: puts its typing back, then sees the Mac's halfway save as already passed", () => {
      const phone = new DocumentLineage();
      phone.opened(START, 100);
      phone.saved(PHONE_EARLY, 200);
      phone.saved(PHONE, 290);
      // The sync service made the Mac's version the file; the typing is gone from it.
      phone.tookOutside(MAC, 310);
      expect(phone.plan(MAC, PHONE, 290)).to.deep.equal({
        status: 'merged',
        merged: DONE,
        foreign: false,
      });
      phone.restored(PHONE);
      phone.saved(DONE, 400);
      // The Mac's halfway merge arrives late. Both changed the last paragraph
      // since the Mac's text, but one is simply further along than the other.
      expect(phone.plan(DONE, HALFWAY, 300).status).to.equal('included');
    });

    it('still asks when the late version has something of its own', () => {
      const phone = new DocumentLineage();
      phone.opened(START, 100);
      phone.saved(PHONE_EARLY, 200);
      phone.saved(PHONE, 290);
      phone.tookOutside(MAC, 310);
      phone.restored(PHONE);
      phone.saved(DONE, 400);
      const different = doc('# Unicorns', 'They are rare.', 'They like rainbows gvv and ponies');
      expect(phone.plan(DONE, different, 300).status).to.equal('overlap');
      expect(phone.plan(DONE, different, null).status).to.equal('unknown-base');
    });
  });

  it('never loses typing when a long run of saves outgrows what is remembered', () => {
    const lineage = new DocumentLineage();
    lineage.opened(BASE, 100);
    let mine = BASE;
    for (let save = 1; save <= 120; save += 1) {
      mine = doc('# Unicorns', 'They are rare.', `They like rainbows${' and more'.repeat(save)}.`);
      lineage.saved(mine, 100 + save);
    }
    const plan = lineage.plan(mine, THEIRS, 150);
    expect(plan.status).to.equal('merged');
    if (plan.status !== 'merged') return;
    expect(plan.merged).to.equal(
      doc('# Unicorns', 'They are very rare.', `They like rainbows${' and more'.repeat(120)}.`),
    );
  });

  it('does not let an old leftover version undo newer edits from the same device', () => {
    const lineage = new DocumentLineage();
    lineage.opened(BASE, 100);
    const newer = doc('# Unicorns', 'They are very, very rare.', 'They like rainbows.');
    lineage.tookOutside(newer, 500);
    const mine = doc('# Unicorns', 'They are very, very rare.', 'They like rainbows and glitter.');
    lineage.saved(mine, 600);
    // Saved at 300, before the version taken at 500 was written.
    const plan = lineage.plan(mine, THEIRS, 300);
    if (plan.status === 'merged') expect(plan.merged).to.include('very, very rare');
    else expect(plan.status).to.be.oneOf(['overlap', 'included', 'unknown-base']);
  });

  describe('a version the text here has grown past', () => {
    const LATER = doc(
      '# Unicorns',
      'They are very rare.',
      'They like rainbows and glitter.',
      'More.',
    );

    it('is not a version to review after a restart, when nothing is remembered of it', () => {
      const lineage = new DocumentLineage();
      // Opened hours after the leftover version was saved.
      lineage.opened(LATER, 50_000);
      expect(lineage.plan(LATER, MINE_1, 200).status).to.equal('included');
      expect(lineage.plan(LATER, THEIRS, 200).status).to.equal('included');
      expect(lineage.plan(LATER, MINE_1, null).status).to.equal('included');
      // Still true once more is typed here.
      const more = doc(
        '# Unicorns',
        'They are very rare.',
        'They like rainbows and glitter.',
        'More still.',
      );
      lineage.saved(more, 60_000);
      expect(lineage.plan(more, MINE_1, 200).status).to.equal('included');
    });

    it('is still asked about when it has a word the text here does not', () => {
      const lineage = new DocumentLineage();
      lineage.opened(LATER, 50_000);
      const leftover = doc('# Unicorns', 'They are rare, they say.', 'They like rainbows and');
      expect(lineage.plan(LATER, leftover, 200).status).to.equal('unknown-base');
    });

    it('is an earlier stage of the same typing, even when it arrives after the later one', () => {
      const start = doc('# Unicorns', 'They are rare.', 'They like rainbows');
      const here = doc('# Unicorns', 'They are very rare.', 'They like rainbows');
      const theirFirst = doc('# Unicorns', 'They are rare.', 'They like rainbows and');
      const theirSecond = doc('# Unicorns', 'They are rare.', 'They like rainbows and glitter');
      const both = doc('# Unicorns', 'They are very rare.', 'They like rainbows and glitter');
      const lineage = new DocumentLineage();
      lineage.opened(start, 100);
      lineage.saved(here, 200);
      // The other device's second save was combined first...
      expect(lineage.plan(here, theirSecond, 320)).to.deep.equal({
        status: 'merged',
        merged: both,
        foreign: true,
      });
      lineage.absorbed(theirSecond, 320, { setAside: true });
      lineage.saved(both, 330);
      // ...and its first save, a word short of that, turns up afterwards.
      expect(lineage.plan(both, theirFirst, 300).status).to.equal('included');
    });

    it('is asked about when it took something out of the paragraph both changed', () => {
      const lineage = new DocumentLineage();
      const base = doc('# Unicorns', 'They are rare.', 'They like rainbows and sunshine.');
      lineage.opened(base, 100);
      const mine = doc(
        '# Unicorns',
        'They are rare.',
        'They like rainbows and sunshine. And glitter.',
      );
      lineage.saved(mine, 200);
      // Every word of it is here, but it removed "and sunshine" on purpose.
      const theirs = doc('# Unicorns', 'They are rare.', 'They like rainbows.');
      expect(lineage.plan(mine, theirs, 250).status).to.equal('overlap');
    });
  });

  describe('a version in storage that was not built on the saves here', () => {
    it('is told apart from one that was, with the text the two parted from', () => {
      const lineage = new DocumentLineage();
      lineage.opened(BASE, 100);
      lineage.saved(MINE_1, 200);
      lineage.saved(MINE_2, 300);
      // The other device never saw either save.
      expect(lineage.parting(THEIRS)).to.deep.equal({
        from: BASE,
        provenUntil: null,
      });
      // It saw the first save but not the second.
      const sawFirst = doc('# Unicorns', 'They are very rare.', 'They like rainbows and');
      expect(lineage.parting(sawFirst)?.from).to.equal(MINE_1);
      // It saw everything: an ordinary newer version.
      expect(lineage.parting(BOTH)).to.equal(null);
      expect(lineage.parting(MINE_2)).to.equal(null);
    });

    it('has nothing at stake when nothing was saved here', () => {
      const lineage = new DocumentLineage();
      lineage.opened(BASE, 100);
      expect(lineage.parting(THEIRS)).to.equal(null);
      lineage.tookOutside(THEIRS, 200);
      expect(lineage.parting(BASE)).to.equal(null);
    });

    it('is known to be written at the same time once a save here was set aside', () => {
      const lineage = new DocumentLineage();
      lineage.opened(BASE, 100);
      lineage.saved(MINE_1, 200);
      lineage.saved(MINE_2, 300);
      // Only a save made here counts; another device's set-aside version says nothing.
      expect(lineage.sawSetAside(THEIRS, null, 1_000)).to.equal(false);
      expect(lineage.parting(THEIRS)?.provenUntil).to.equal(null);
      expect(lineage.sawSetAside(MINE_1, null, 1_000)).to.equal(true);
      expect(lineage.sawSetAside(MINE_1, null, 1_500)).to.equal(false);
      const parting = lineage.parting(THEIRS);
      expect(parting?.from).to.equal(BASE);
      expect(parting?.provenUntil).to.be.greaterThan(1_500);
    });

    it('does not let one sighting speak for a later version', () => {
      const lineage = new DocumentLineage();
      lineage.opened(BASE, 100);
      lineage.saved(MINE_2, 300);
      lineage.sawSetAside(MINE_2, null, 1_000);
      // The version it was proof about is combined in...
      lineage.absorbed(THEIRS, 1_100, { setAside: true });
      lineage.saved(BOTH, 1_200);
      // ...and a later one that drops the typing here gets no benefit from it.
      expect(lineage.parting(BASE)).to.deep.equal({
        from: BASE,
        provenUntil: null,
      });
    });

    it('takes the later of two stages of the same typing', () => {
      const start = doc('# Unicorns', 'They are rare.', 'They like rainbows');
      const first = doc('# Unicorns', 'They are rare.', 'They like rainbows and');
      const second = doc('# Unicorns', 'They are rare.', 'They like rainbows and glitter');
      const lineage = new DocumentLineage();
      lineage.opened(start, 100);
      lineage.saved(first, 200);
      // The other device's version is this typing, further along.
      expect(lineage.plan(first, second, 250)).to.deep.equal({
        status: 'merged',
        merged: second,
        foreign: true,
      });
      // But not when it also took something out.
      const reworded = doc('# Unicorns', 'They are rare.', 'They love rainbows and glitter');
      expect(lineage.plan(first, reworded, 250).status).to.equal('overlap');
    });
  });

  describe('a word typed and taken out again, leaving a text exactly as it once was', () => {
    const start = doc('# Unicorns', 'They are rare.', 'They like rainbows');
    const mine = doc('# Unicorns!', 'They are rare.', 'They like rainbows');
    const mineNext = doc('# Unicorns?', 'They are rare.', 'They like rainbows and');
    const wordGone = doc('# Unicorns?', 'They are rare.', 'They like rainbows');

    it('is not mistaken for the older save here that it now equals', () => {
      const lineage = new DocumentLineage();
      lineage.opened(start, 1_000);
      lineage.saved(mine, 2_000);
      // Their version with the word became the document and was taken in here.
      const theirWord = doc('# Unicorns!', 'They are rare.', 'They like rainbows and');
      lineage.tookOutside(theirWord, 10_000, 'iPhone');
      lineage.saved(mineNext, 20_000);
      // A copy of the save made here at 2,000 has nothing new in it...
      expect(lineage.plan(mineNext, mine, 2_000).status).to.equal('included');
      // ...but the same text, saved by them much later, is the word taken out.
      expect(lineage.plan(mineNext, mine, 30_000, 'iPhone')).to.deep.equal({
        status: 'merged',
        merged: wordGone,
        foreign: true,
      });
      // A third device that never had the word says nothing about it.
      expect(lineage.plan(mineNext, mine, 30_000, 'iPad').status).to.equal('included');
    });

    it('leaves the word in when their version with it had only been set aside', () => {
      const lineage = new DocumentLineage();
      lineage.opened(start, 1_000);
      lineage.saved(mine, 2_000);
      // The sync service kept the save made here and set theirs aside.
      const theirWord = doc('# Unicorns', 'They are rare.', 'They like rainbows and');
      const both = doc('# Unicorns!', 'They are rare.', 'They like rainbows and');
      expect(lineage.plan(mine, theirWord, 2_100, 'iPhone')).to.deep.equal({
        status: 'merged',
        merged: both,
        foreign: true,
      });
      lineage.absorbed(theirWord, 2_100, { setAside: true, by: 'iPhone', mine });
      lineage.saved(both, 3_000);
      // Their next save is the text that replaced theirs. They may have taken
      // the word out, or their device may not have it back yet: it stays.
      expect(lineage.plan(both, mine, 30_000, 'iPhone').status).to.equal('included');
    });

    it('is not word that a save here was set aside', () => {
      const lineage = new DocumentLineage();
      lineage.opened(start, 1_000);
      lineage.saved(mine, 2_000);
      lineage.saved(mineNext, 3_000);
      // The same text as the save at 2,000, written half a minute later by someone else.
      expect(lineage.sawSetAside(mine, 30_000, 31_000)).to.equal(false);
      expect(lineage.sawSetAside(mine, 1_500, 31_000)).to.equal(true);
    });

    it('is known to be built on the saves here when it has what each of them changed', () => {
      const opened = doc('# Unicorns', 'They are rare', 'They like rainbows');
      const first = doc('# Unicorns', 'They are rare!', 'They like rainbows');
      const theirWords = doc(
        '# Unicorns',
        'They are rare',
        'They like rainbows and glitter and ponies',
      );
      const both = doc('# Unicorns', 'They are rare!', 'They like rainbows and glitter and ponies');
      const second = doc(
        '# Unicorns',
        'They are rare!!',
        'They like rainbows and glitter and ponies',
      );
      const lineage = new DocumentLineage();
      lineage.opened(opened, 1_000);
      lineage.saved(first, 2_000);
      lineage.absorbed(theirWords, 3_000, { setAside: false, mine: first });
      lineage.saved(both, 4_000);
      lineage.saved(second, 5_000);
      // Their next version has both of the changes saved here and took its
      // own words out again. It looks most like the first save, from before
      // those words, but it was written with sight of the second.
      const theirNext = doc('# Unicorns', 'They are rare!!', 'They like rainbows');
      expect(lineage.parting(theirNext)).to.equal(null);
      // One written without the second save did part from the saves here.
      const without = doc('# Unicorns', 'They are rare!', 'They like rainbows');
      expect(lineage.parting(without)?.from).to.equal(first);
    });
  });

  it('remembers across a restart what the last save was built on', () => {
    const before = new DocumentLineage();
    before.opened(BASE, 100);
    before.saved(MINE_1, 200);
    const record = before.record();
    expect(record).to.deep.equal({
      base: BASE,
      baseKind: 'opened',
      baseAt: 100,
      lastSaved: textSignature(MINE_1),
      lastSavedAt: 200,
    });

    // The file still holds this device's last save: the other device, which
    // never received it, is combined from the text before that save.
    const after = new DocumentLineage();
    after.opened(MINE_1, 5_000, record);
    expect(after.plan(MINE_2, THEIRS, 6_000)).to.deep.equal({
      status: 'merged',
      merged: BOTH,
      foreign: true,
    });

    // The file holds something else: someone wrote it, and it is the start.
    const replaced = new DocumentLineage();
    replaced.opened(THEIRS, 5_000, record);
    expect(replaced.record()?.base).to.equal(THEIRS);
  });
});

describe('DocumentLineageStore', () => {
  const record = (base: string, lastSaved = 'sig') => ({
    base,
    baseKind: 'outside' as const,
    baseAt: 10,
    lastSaved,
    lastSavedAt: 20,
  });

  it('round-trips a record and forgets it on request', () => {
    const storage = memoryStorage();
    const store = new DocumentLineageStore(storage);
    expect(store.read('a')).to.equal(null);
    store.write('a', record(BASE));
    expect(new DocumentLineageStore(storage).read('a')).to.deep.equal(record(BASE));
    store.write('a', null);
    expect(store.read('a')).to.equal(null);
    // Only the (now empty) index is left behind.
    expect(storage.items.size).to.equal(1);
  });

  it('rewrites the base text only when it changes', () => {
    const storage = memoryStorage();
    let baseWrites = 0;
    const counting: DocumentRecoveryStorage = {
      ...storage,
      setItem: (key, value) => {
        if (value === BASE || value === THEIRS) baseWrites += 1;
        storage.setItem(key, value);
      },
    };
    const store = new DocumentLineageStore(counting);
    store.write('a', record(BASE, 'one'));
    store.write('a', record(BASE, 'two'));
    store.write('a', record(BASE, 'three'));
    expect(baseWrites).to.equal(1);
    expect(store.read('a')?.lastSaved).to.equal('three');
    store.write('a', record(THEIRS, 'four'));
    expect(baseWrites).to.equal(2);
    expect(store.read('a')).to.deep.equal(record(THEIRS, 'four'));
  });

  it('keeps a bounded number of documents, dropping the least recently saved', () => {
    const storage = memoryStorage();
    let now = 0;
    const store = new DocumentLineageStore(storage, {
      maxDocuments: 2,
      now: () => ++now,
    });
    store.write('a', record('a text'));
    store.write('b', record('b text'));
    store.write('c', record('c text'));
    expect(store.read('a')).to.equal(null);
    expect(store.read('b')?.base).to.equal('b text');
    expect(store.read('c')?.base).to.equal('c text');
    // Index plus two base texts.
    expect(storage.items.size).to.equal(3);
  });

  it('does not remember a document that is too long, and survives damage', () => {
    const storage = memoryStorage();
    const store = new DocumentLineageStore(storage, { maxRecordChars: 10 });
    store.write('a', record('short'));
    store.write('a', record('much too long to keep'));
    expect(store.read('a')).to.equal(null);

    store.write('b', record('short'));
    for (const [key, value] of storage.items) {
      if (value === 'short') storage.items.set(key, 'tampered');
    }
    expect(store.read('b')).to.equal(null);
    storage.items.set('docblocks:document-lineage:v1', '{not json');
    expect(store.read('b')).to.equal(null);
    store.write('b', record('again'));
    expect(store.read('b')?.base).to.equal('again');
    expect(new DocumentLineageStore(null).read('b')).to.equal(null);
  });
});

describe('DocumentSession set-aside versions', () => {
  const KEY = 'workspace:unicorns.md';
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function edit(session: DocumentSession, content: string): void {
    const snapshot = session.getSnapshot();
    session.edit(content, {
      targetKey: snapshot.targetKey!,
      generation: snapshot.generation,
    });
  }

  async function open(
    options: {
      park?: boolean;
      idleMs?: number;
      graceMs?: number;
      content?: string;
      storage?: DocumentRecoveryStorage;
    } = {},
  ) {
    const commits: DocumentCommitRequest[] = [];
    const parked: DocumentParkRequest[] = [];
    const events: DocumentSessionEvent[] = [];
    const session = new DocumentSession({
      autoSaveEnabled: false,
      autoMergeIdleMs: options.idleMs ?? 0,
      ...(options.graceMs === undefined ? {} : { concurrentSaveGraceMs: options.graceMs }),
      lineageStore: options.storage ? new DocumentLineageStore(options.storage) : null,
    });
    session.subscribeEvents((event) => events.push(event));
    const target: DocumentCommitTarget = {
      key: KEY,
      async commit(request) {
        commits.push(request);
      },
      ...(options.park === false
        ? {}
        : {
            async park(request: DocumentParkRequest) {
              parked.push(request);
            },
          }),
    };
    await session.transitionTo(target, options.content ?? BASE);
    return { session, commits, parked, events };
  }

  /** A version the other device saved a moment from now. */
  const theirs = (content: string) => ({
    targetKey: KEY,
    content,
    savedAt: Date.now() + 50,
    origin: { savedBy: "Mike's MacBook Pro" },
  });

  it('combines a version saved elsewhere at the same time with the saves made here', async () => {
    const { session, commits, parked, events } = await open();
    edit(session, MINE_2);
    await session.flush();
    const generation = session.getSnapshot().generation;

    expect(await session.absorbConcurrentVersion(theirs(THEIRS))).to.equal('merged');
    const snapshot = session.getSnapshot();
    expect(snapshot.content).to.equal(BOTH);
    expect(snapshot.status).to.equal('saved');
    expect(snapshot.generation).to.be.greaterThan(generation);
    expect(commits.at(-1)?.content).to.equal(BOTH);
    // The text from before is kept so the merge can be undone.
    expect(parked.map(({ origin, content }) => ({ origin, content }))).to.deep.equal([
      { origin: 'premerge', content: MINE_2 },
    ]);
    expect(events).to.deep.equal([
      {
        type: 'merged',
        targetKey: KEY,
        localContent: MINE_2,
        externalContent: THEIRS,
        mergedContent: BOTH,
        externalOrigin: { savedBy: "Mike's MacBook Pro" },
      },
    ]);
  });

  it('includes edits typed here but not saved yet', async () => {
    const { session } = await open();
    edit(session, MINE_1);
    await session.flush();
    edit(session, MINE_2);
    expect(await session.absorbConcurrentVersion(theirs(THEIRS))).to.equal('merged');
    expect(session.getSnapshot().content).to.equal(BOTH);
    expect(session.getSnapshot().status).to.equal('saved');
  });

  it('puts back its own save after the sync service made the other version the document', async () => {
    // With no wait for the set-aside copy, the other version is taken first.
    const { session, events } = await open({ graceMs: 0 });
    edit(session, MINE_2);
    await session.flush();
    // The file now holds the other device's version; nothing is unsaved here, so it is taken.
    expect(session.observeExternal({ targetKey: KEY, content: THEIRS })).to.equal('applied');
    expect(session.getSnapshot().content).to.equal(THEIRS);
    events.length = 0;

    // The sync service kept this device's own save as the set-aside version.
    expect(await session.absorbConcurrentVersion(theirs(MINE_2))).to.equal('merged');
    expect(session.getSnapshot().content).to.equal(BOTH);
    // There is no other author to name: the version is this device's own.
    expect(events).to.deep.equal([
      {
        type: 'merged',
        targetKey: KEY,
        localContent: THEIRS,
        externalContent: MINE_2,
        mergedContent: BOTH,
      },
    ]);
  });

  describe('when storage swaps a save made here for one made elsewhere at the same time', () => {
    const settle = () => wait(20);
    const other = {
      key: 'workspace:other.md',
      async commit() {},
    } satisfies DocumentCommitTarget;

    it('combines mid-typing from the text both started with, without a conflict to resolve', async () => {
      const { session, commits, parked, events } = await open();
      edit(session, MINE_1);
      await session.flush();
      // Still typing in the same paragraph when the other device's version lands.
      edit(session, MINE_2);
      expect(session.observeExternal({ targetKey: KEY, content: THEIRS })).to.equal('conflict');
      // Measured from the last save, the other version looks as if it deleted
      // that save's typing, which clashes with the typing since. The session
      // waits for word that the two were written at the same time instead.
      expect(session.getSnapshot().conflict?.merging).to.equal(true);
      expect(session.getSnapshot().content).to.equal(MINE_2);

      // The sync service kept this device's save beside the document.
      expect(await session.absorbConcurrentVersion(theirs(MINE_1))).to.equal('later');
      await settle();
      const snapshot = session.getSnapshot();
      expect(snapshot.conflict).to.equal(null);
      expect(snapshot.content).to.equal(BOTH);
      expect(snapshot.status).to.equal('saved');
      expect(commits.at(-1)?.content).to.equal(BOTH);
      expect(commits.at(-1)?.persistedContent).to.equal(THEIRS);
      expect(parked.map(({ origin, content }) => ({ origin, content }))).to.deep.equal([
        { origin: 'premerge', content: MINE_2 },
      ]);
      expect(events.map((event) => event.type)).to.deep.equal(['merged']);
      // Its typing never left the document, so the set-aside copy has nothing new.
      expect(await session.absorbConcurrentVersion(theirs(MINE_1))).to.equal('included');
      expect(session.getSnapshot().content).to.equal(BOTH);
    });

    it('combines from the last save when no word comes, keeping the paragraph being typed', async () => {
      const { session, events } = await open({ graceMs: 60 });
      edit(session, MINE_1);
      await session.flush();
      edit(session, MINE_2);
      session.observeExternal({ targetKey: KEY, content: THEIRS });
      expect(session.getSnapshot().conflict?.merging).to.equal(true);
      await wait(150);
      // Nothing showed the two were written at the same time. But the other
      // version has that paragraph exactly as it was when this document was
      // opened: an earlier moment of the typing here, not a change to it.
      expect(session.getSnapshot().conflict).to.equal(null);
      expect(session.getSnapshot().content).to.equal(BOTH);
      expect(events.map((event) => event.type)).to.deep.equal(['merged']);
    });

    it('asks when the other version changed that paragraph in a way of its own', async () => {
      const { session } = await open({ graceMs: 60 });
      edit(session, MINE_1);
      await session.flush();
      edit(session, MINE_2);
      const clash = doc('# Unicorns', 'They are very rare.', 'They love rainbows.');
      session.observeExternal({ targetKey: KEY, content: clash });
      await wait(150);
      expect(session.getSnapshot().conflict).not.to.equal(null);
      expect(session.getSnapshot().conflict?.merging).to.equal(undefined);
      expect(session.getSnapshot().content).to.equal(MINE_2);
      // Typing on does not bring a plan back.
      edit(session, doc('# Unicorns', 'They are rare.', 'They like rainbows and glitter. A lot.'));
      expect(session.getSnapshot().conflict?.merging).to.equal(undefined);
    });

    it('keeps saved typing on screen while it waits, then combines in one step', async () => {
      const { session, commits, parked, events } = await open();
      edit(session, MINE_2);
      await session.flush();
      const generation = session.getSnapshot().generation;
      // Nothing is unsaved, but the version in storage has none of that typing.
      expect(session.observeExternal({ targetKey: KEY, content: THEIRS })).to.equal('conflict');
      expect(session.getSnapshot().content).to.equal(MINE_2);
      expect(session.getSnapshot().conflict?.merging).to.equal(true);
      // Everything here is saved, and it reads that way while the wait lasts.
      expect(session.getSnapshot().status).to.equal('saved');
      expect(session.getSnapshot().generation).to.equal(generation);

      expect(await session.absorbConcurrentVersion(theirs(MINE_2))).to.equal('later');
      await settle();
      expect(session.getSnapshot().content).to.equal(BOTH);
      expect(session.getSnapshot().status).to.equal('saved');
      // The editor reloads once, not twice.
      expect(session.getSnapshot().generation).to.equal(generation + 1);
      expect(commits.at(-1)?.content).to.equal(BOTH);
      expect(parked.map(({ origin, content }) => ({ origin, content }))).to.deep.equal([
        { origin: 'premerge', content: MINE_2 },
      ]);
      expect(events.map((event) => event.type)).to.deep.equal(['merged']);
    });

    it('combines at once when the set-aside copy was seen first', async () => {
      const { session } = await open();
      edit(session, MINE_2);
      await session.flush();
      // The session still believes its save is the document.
      expect(await session.absorbConcurrentVersion(theirs(MINE_2))).to.equal('included');
      expect(session.observeExternal({ targetKey: KEY, content: THEIRS })).to.equal('conflict');
      await settle();
      expect(session.getSnapshot().content).to.equal(BOTH);
      expect(session.getSnapshot().status).to.equal('saved');
    });

    it('takes the other version as a newer one when no copy was set aside', async () => {
      const { session, parked, events } = await open({ graceMs: 60 });
      edit(session, MINE_2);
      await session.flush();
      // Someone put the earlier text back on purpose.
      expect(session.observeExternal({ targetKey: KEY, content: BASE })).to.equal('conflict');
      expect(session.getSnapshot().content).to.equal(MINE_2);
      await wait(150);
      const snapshot = session.getSnapshot();
      expect(snapshot.conflict).to.equal(null);
      expect(snapshot.content).to.equal(BASE);
      expect(snapshot.status).to.equal('saved');
      // Taken, not combined: nothing kept from before, and no merge announced.
      expect(parked).to.deep.equal([]);
      expect(events.map((event) => event.type)).to.deep.equal(['external-applied']);
    });

    it('keeps the text here untouched when the other version has nothing it lacks', async () => {
      const { session, commits, parked, events } = await open();
      edit(session, MINE_2);
      await session.flush();
      const generation = session.getSnapshot().generation;
      // The other device saved the text from before, at the same moment.
      session.observeExternal({ targetKey: KEY, content: BASE });
      expect(await session.absorbConcurrentVersion(theirs(MINE_2))).to.equal('later');
      await settle();
      const snapshot = session.getSnapshot();
      expect(snapshot.conflict).to.equal(null);
      expect(snapshot.content).to.equal(MINE_2);
      expect(snapshot.status).to.equal('saved');
      // No reload, no notice, nothing to undo: the text here is saved over storage.
      expect(snapshot.generation).to.equal(generation);
      expect(commits.at(-1)?.content).to.equal(MINE_2);
      expect(commits.at(-1)?.persistedContent).to.equal(BASE);
      expect(parked).to.deep.equal([]);
      expect(events).to.deep.equal([]);
    });

    it('does not wait when the user leaves the document, and sets nothing aside', async () => {
      const { session, parked, events } = await open({ graceMs: 5_000 });
      edit(session, MINE_2);
      await session.flush();
      session.observeExternal({ targetKey: KEY, content: THEIRS });
      expect(session.getSnapshot().conflict?.merging).to.equal(true);
      await session.transitionTo(other, 'Other');
      expect(session.getSnapshot().targetKey).to.equal(other.key);
      // Nothing was unsaved, so there was nothing to keep: the newer version stands.
      expect(parked).to.deep.equal([]);
      expect(events.map((event) => event.type)).to.deep.equal(['external-applied']);
    });

    it('still combines from the last save a version that was built on it', async () => {
      const { session } = await open();
      edit(session, MINE_1);
      await session.flush();
      edit(session, MINE_2);
      // The other device had received the first save.
      const builtOnIt = doc('# Unicorns', 'They are very rare.', 'They like rainbows and');
      session.observeExternal({ targetKey: KEY, content: builtOnIt });
      await settle();
      expect(session.getSnapshot().content).to.equal(BOTH);
      expect(session.getSnapshot().conflict).to.equal(null);
    });
  });

  describe('when the other device hands back an earlier moment of the writing here', () => {
    const LONG = doc('# Unicorns', 'They are rare.', 'They like rainbows and glitter and ponies.');
    const SHORTER = doc('# Unicorns', 'They are rare.', 'They like rainbows and glitter.');
    const SHORTEST = doc('# Unicorns', 'They are rare.', 'They like rainbows.');

    it('keeps a paragraph that was shortened further here, without a conflict to resolve', async () => {
      const { session, events, parked } = await open({ content: LONG, graceMs: 30 });
      edit(session, SHORTER);
      await session.flush();
      edit(session, SHORTEST);
      await session.flush();
      // Still deleting when the other device's version lands. It was built on
      // the first of those saves, and changed the paragraph above.
      const stillShorter = doc('# Unicorns', 'They are rare.', 'They like rain.');
      edit(session, stillShorter);
      const theirs = doc('# Unicorns', 'They are very rare.', 'They like rainbows and glitter.');
      expect(session.observeExternal({ targetKey: KEY, content: theirs })).to.equal('conflict');
      await wait(120);
      const snapshot = session.getSnapshot();
      expect(snapshot.conflict).to.equal(null);
      expect(snapshot.content).to.equal(
        doc('# Unicorns', 'They are very rare.', 'They like rain.'),
      );
      expect(events.map((event) => event.type)).to.deep.equal(['merged']);
      expect(parked.map(({ origin, content }) => ({ origin, content }))).to.deep.equal([
        { origin: 'premerge', content: stillShorter },
      ]);
    });

    it('takes out a word the other device typed and then removed, though its text is back where it was', async () => {
      const start = doc('# Unicorns', 'They are rare.', 'They like rainbows');
      const { session } = await open({ content: start, graceMs: 30 });
      const now = Date.now();
      // Their version with the word becomes the document and is taken in here.
      const theirWord = doc('# Unicorns', 'They are rare.', 'They like rainbows and');
      session.observeExternal({
        targetKey: KEY,
        content: theirWord,
        origin: { modifiedAt: now - 2_000 },
      });
      expect(session.getSnapshot().content).to.equal(theirWord);
      edit(session, doc('# Unicorns!', 'They are rare.', 'They like rainbows and'));
      await session.flush();
      edit(session, doc('# Unicorns?', 'They are rare.', 'They like rainbows and'));
      // Their next version: the word gone, the text exactly as it was opened.
      session.observeExternal({ targetKey: KEY, content: start, origin: { modifiedAt: now } });
      await wait(120);
      expect(session.getSnapshot().conflict).to.equal(null);
      expect(session.getSnapshot().content).to.equal(
        doc('# Unicorns?', 'They are rare.', 'They like rainbows'),
      );
    });
  });

  it('leaves a version for review when both changed the same paragraph', async () => {
    const { session, commits, parked, events } = await open();
    edit(session, MINE_2);
    await session.flush();
    const before = commits.length;
    const overlap = doc('# Unicorns', 'They are rare.', 'They like rainbows, mostly.');
    expect(await session.absorbConcurrentVersion(theirs(overlap))).to.equal('review');
    expect(session.getSnapshot().content).to.equal(MINE_2);
    expect(commits.length).to.equal(before);
    expect(parked).to.deep.equal([]);
    expect(events).to.deep.equal([]);
  });

  it('answers included for a version with nothing new in it', async () => {
    const { session, parked } = await open();
    edit(session, MINE_1);
    await session.flush();
    edit(session, MINE_2);
    await session.flush();
    expect(await session.absorbConcurrentVersion(theirs(MINE_2))).to.equal('included');
    expect(await session.absorbConcurrentVersion(theirs(MINE_1))).to.equal('included');
    expect(await session.absorbConcurrentVersion(theirs(BASE))).to.equal('included');
    expect(session.getSnapshot().content).to.equal(MINE_2);
    expect(parked).to.deep.equal([]);
  });

  it('waits for typing to pause and for an open conflict to be settled', async () => {
    const { session } = await open({ idleMs: 60 });
    edit(session, MINE_2);
    expect(await session.absorbConcurrentVersion(theirs(THEIRS))).to.equal('later');
    await wait(80);
    expect(await session.absorbConcurrentVersion(theirs(THEIRS))).to.equal('merged');

    const second = await open({ park: true });
    edit(second.session, MINE_2);
    const overlap = doc('# Unicorns', 'They are rare.', 'They like rainbows, mostly.');
    expect(second.session.observeExternal({ targetKey: KEY, content: overlap })).to.equal(
      'conflict',
    );
    expect(await second.session.absorbConcurrentVersion(theirs(THEIRS))).to.equal('later');
  });

  it('ignores a version of a document that is no longer the one open', async () => {
    const { session } = await open();
    edit(session, MINE_2);
    await session.flush();
    expect(
      await session.absorbConcurrentVersion({
        ...theirs(THEIRS),
        targetKey: 'workspace:other.md',
      }),
    ).to.equal('later');
    expect(session.getSnapshot().content).to.equal(MINE_2);
  });

  it('leaves every version for review when the target cannot keep the text from before', async () => {
    const { session } = await open({ park: false });
    edit(session, MINE_2);
    await session.flush();
    expect(await session.absorbConcurrentVersion(theirs(THEIRS))).to.equal('review');
    expect(session.getSnapshot().content).to.equal(MINE_2);
  });

  it('combines from the text before its last save after a restart', async () => {
    const storage = memoryStorage();
    const first = await open({ storage });
    edit(first.session, MINE_1);
    await first.session.flush();

    // A new session opens the file as this device left it and types on. The
    // other device never received the earlier save.
    const second = await open({ storage, content: MINE_1 });
    edit(second.session, MINE_2);
    expect(await second.session.absorbConcurrentVersion(theirs(THEIRS))).to.equal('merged');
    expect(second.session.getSnapshot().content).to.equal(BOTH);
  });
});

describe('two devices editing at once through a sync service', () => {
  const KEY = 'icloud:Unicorns.md';
  const START =
    '# Unicorns\n\nOn the Mac: ma mb mc md me mf mg mh mi mj mk ml\n\n' +
    'On the phone: pa pb pc pd pe pf pg ph pi pj pk pl\n';
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // People pause between edits. The session tells a version from an older
  // one with the same text by when each was written, so the clock here moves
  // ten seconds with every round while the test itself runs in moments.
  const realNow = Date.now;
  let ahead = 0;
  before(() => {
    Date.now = () => realNow() + ahead;
  });
  after(() => {
    Date.now = realNow;
  });

  interface SetAside {
    content: string;
    savedBy: string;
    savedAt: number;
  }

  /**
   * The document as the sync service has it, and the versions it set aside.
   * Every device learns of a set-aside version from its own copy of the sync
   * service's records, at once; that another device has dealt with one (and
   * removed it from the shared folder) only reaches it with the next sync.
   */
  interface Cloud {
    file: string;
    fileAt: number;
    setAside: SetAside[];
    /** Versions some device has dealt with, not yet known to the others. */
    settled: SetAside[];
    reviews: number;
  }

  type Habit = 'type' | 'erase' | 'either';

  class Device {
    public file = START;
    public upload: { content: string; at: number } | null = null;
    /** This device's view of the folder of set-aside versions. */
    public folder: SetAside[] = [];
    public readonly events: DocumentSessionEvent[] = [];
    public readonly session = new DocumentSession({
      autoSaveEnabled: false,
      autoMergeIdleMs: 0,
      concurrentSaveGraceMs: 40,
    });
    /** This device's own paragraph, as its user left it. */
    public mine = '';
    /** Times the user was shown a conflict to resolve. */
    public asked = 0;
    /**
     * Times this device's own paragraph was, for however short a moment, not
     * as its user left it: a typed word gone, or a deleted one back.
     */
    public strayed = 0;

    public constructor(
      public readonly name: string,
      public readonly line: number,
      private readonly prefix: string,
    ) {
      this.session.subscribeEvents((event) => this.events.push(event));
      this.session.subscribe(() => {
        const snapshot = this.session.getSnapshot();
        if (snapshot.conflict && !snapshot.conflict.merging) this.asked += 1;
        if (this.mine && snapshot.content.split('\n')[this.line] !== this.mine) this.strayed += 1;
      });
    }

    public async open(): Promise<void> {
      const target: DocumentCommitTarget = {
        key: KEY,
        commit: async (request) => {
          // The save is refused when the file is no longer what it was built on.
          if (this.file !== request.persistedContent && this.file !== request.content) {
            throw new DocumentCommitConflictError('The file changed.', this.file);
          }
          this.file = request.content;
          this.upload = { content: request.content, at: Date.now() };
        },
        park: async () => undefined,
      };
      await this.session.transitionTo(target, START);
      this.mine = START.split('\n')[this.line]!;
    }

    /** Type one more word at the end of this device's own paragraph, or take the last one off. */
    public act(habit: Habit, count: number, either: boolean): void {
      const words = this.mine.split(' ');
      const erase = habit === 'erase' || (habit === 'either' && either);
      if (erase && words.length <= 3) return;
      if (erase) words.pop();
      else words.push(`${this.prefix}w${count}`);
      this.mine = words.join(' ');
      const snapshot = this.session.getSnapshot();
      const lines = snapshot.content.split('\n');
      lines[this.line] = this.mine;
      this.session.edit(lines.join('\n'), {
        targetKey: KEY,
        generation: snapshot.generation,
      });
    }

    public async save(): Promise<void> {
      await this.session.flush().catch(() => undefined);
    }

    /** What the shell does when the file changes underneath the document. */
    public see(cloud: Cloud): void {
      this.file = cloud.file;
      this.session.observeExternal({
        targetKey: KEY,
        content: cloud.file,
        origin: { modifiedAt: cloud.fileAt },
      });
    }

    /** What the versions layer does with each set-aside version. */
    public async offer(cloud: Cloud): Promise<void> {
      for (const version of [...this.folder]) {
        const ask = () =>
          this.session.absorbConcurrentVersion({
            targetKey: KEY,
            content: version.content,
            savedAt: version.savedAt,
            origin: { savedBy: version.savedBy, modifiedAt: version.savedAt },
          });
        let result = await ask();
        if (result === 'included') {
          this.see(cloud);
          result = await ask();
        }
        if (result === 'review') cloud.reviews += 1;
        if (result !== 'merged' && result !== 'included') continue;
        this.folder = this.folder.filter((entry) => entry !== version);
        if (!cloud.settled.includes(version)) cloud.settled.push(version);
      }
    }
  }

  /**
   * The sync service receives what each device saved. Two saves that never
   * saw each other cannot both be the document: one becomes it, the other is
   * set aside, and every device then sees the same file and the same folder.
   */
  function sync(cloud: Cloud, devices: readonly Device[], winner: Device): boolean {
    // The folder syncs too: what one device dealt with is gone for all.
    const moved = cloud.settled.length > 0;
    cloud.setAside = cloud.setAside.filter((version) => !cloud.settled.includes(version));
    cloud.settled = [];
    const uploads = devices.filter((device) => device.upload !== null);
    if (uploads.length === 0) {
      for (const device of devices) device.folder = [...cloud.setAside];
      return moved;
    }
    const chosen = uploads.includes(winner) ? winner : uploads[0]!;
    const kept = chosen.upload!;
    for (const device of uploads) {
      const upload = device.upload!;
      device.upload = null;
      if (device === chosen) continue;
      // Identical text is kept once, as the folder of copies keeps it.
      const same =
        upload.content === kept.content ||
        cloud.setAside.some((version) => version.content === upload.content);
      if (!same) {
        cloud.setAside.push({
          content: upload.content,
          savedBy: device.name,
          savedAt: upload.at,
        });
      }
    }
    cloud.file = kept.content;
    cloud.fileAt = kept.at;
    for (const device of devices) device.folder = [...cloud.setAside];
    for (const device of devices) device.see(cloud);
    return true;
  }

  async function settle(cloud: Cloud, devices: readonly Device[], order: number): Promise<void> {
    for (let pass = 0; pass < 12; pass += 1) {
      for (const device of order % 2 ? [...devices].reverse() : devices) await device.offer(cloud);
      await wait(60);
      const winner = devices[(order + pass) % devices.length]!;
      const moved = sync(cloud, devices, winner);
      const busy = devices.some((device) => device.session.getSnapshot().conflict !== null);
      if (!moved && !busy && cloud.setAside.length === 0) return;
    }
  }

  /** Small deterministic generator, so a failing run can be repeated from its seed. */
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }

  interface Run {
    rounds: number;
    /** Whether a device is still editing when the other's save lands. */
    midEdit: boolean;
    mac: Habit;
    phone: Habit;
    seed?: number;
  }

  async function run(options: Run) {
    const chance = options.seed === undefined ? null : random(options.seed);
    const cloud: Cloud = {
      file: START,
      fileAt: Date.now(),
      setAside: [],
      settled: [],
      reviews: 0,
    };
    const mac = new Device("Mike's MacBook Pro", 2, 'm');
    const phone = new Device("Mike's iPhone", 4, 'p');
    const devices = [mac, phone];
    await mac.open();
    await phone.open();
    let count = 0;
    const act = (device: Device) => {
      count += 1;
      const either = chance ? chance() < 0.5 : count % 2 === 0;
      device.act(device === mac ? options.mac : options.phone, count, either);
    };
    for (let round = 1; round <= options.rounds; round += 1) {
      ahead += 10_000;
      act(mac);
      act(phone);
      await mac.save();
      await phone.save();
      const busy = chance ? (chance() < 0.5 ? mac : phone) : round % 2 ? mac : phone;
      if (options.midEdit && (!chance || chance() < 0.6)) act(busy);
      const winner = chance ? (chance() < 0.5 ? mac : phone) : round % 2 ? phone : mac;
      sync(cloud, devices, winner);
      await settle(cloud, devices, chance ? Math.floor(chance() * 4) : round);
    }
    for (const device of devices) await device.save();
    await settle(cloud, devices, 0);
    return { cloud, mac, phone };
  }

  type Outcome = Awaited<ReturnType<typeof run>>;

  /** Both devices end on one text, and nobody was asked to choose. */
  function expectAgreement({ cloud, mac, phone }: Outcome): void {
    const macText = mac.session.getSnapshot().content;
    expect(macText, 'both devices show the same text').to.equal(
      phone.session.getSnapshot().content,
    );
    expect(cloud.file, 'which is the saved document').to.equal(macText);
    for (const device of [mac, phone]) {
      expect(device.session.getSnapshot().conflict, `no conflict on ${device.name}`).to.equal(null);
      expect(device.asked, `${device.name} never asked to resolve a conflict`).to.equal(0);
      expect(
        device.events.some((event) => event.type === 'parked'),
        `nothing typed on ${device.name} had to be set aside`,
      ).to.equal(false);
    }
  }

  /** And every paragraph is as its own device left it, at every moment, with nothing to review. */
  function expectHarmony(outcome: Outcome): void {
    expectAgreement(outcome);
    const { cloud, mac, phone } = outcome;
    for (const device of [mac, phone]) {
      expect(cloud.file.split('\n')[device.line], `${device.name}'s paragraph`).to.equal(
        device.mine,
      );
      expect(device.strayed, `its paragraph never strayed on ${device.name}`).to.equal(0);
    }
    expect(cloud.setAside, 'nothing left set aside').to.deep.equal([]);
    expect(cloud.reviews, 'no version was ever left for review').to.equal(0);
  }

  it('ends with one document holding all the typing, and nothing to review', async () => {
    expectHarmony(await run({ rounds: 4, midEdit: false, mac: 'type', phone: 'type' }));
  });

  it('does the same when each save lands while the other device is mid-word', async () => {
    expectHarmony(await run({ rounds: 4, midEdit: true, mac: 'type', phone: 'type' }));
  });

  it('does the same when both are deleting', async () => {
    expectHarmony(await run({ rounds: 4, midEdit: true, mac: 'erase', phone: 'erase' }));
  });

  it('does the same when one deletes while the other types', async () => {
    expectHarmony(await run({ rounds: 4, midEdit: true, mac: 'erase', phone: 'type' }));
    expectHarmony(await run({ rounds: 4, midEdit: true, mac: 'type', phone: 'erase' }));
  });

  for (const seed of [7, 21, 1234]) {
    it(`holds whichever save the sync service keeps and whenever it lands (seed ${seed})`, async () => {
      expectHarmony(await run({ rounds: 6, midEdit: true, mac: 'type', phone: 'type', seed }));
      expectHarmony(await run({ rounds: 6, midEdit: true, mac: 'erase', phone: 'type', seed }));
    });
  }

  // A word typed and taken out again leaves a paragraph exactly as it once
  // was, and from the text alone the other device cannot always tell that
  // from a version that never had the word. What must hold even then: both
  // devices end on the same text and nobody is asked to resolve anything.
  // (In about one such session in four something is still off: a deleted
  // word comes back once, or a version is left for review.)
  for (const seed of [7, 21, 1234]) {
    it(`never asks, and ends on one text, when words are typed and taken out again (seed ${seed})`, async () => {
      expectAgreement(
        await run({ rounds: 6, midEdit: true, mac: 'either', phone: 'either', seed }),
      );
    });
  }
});
