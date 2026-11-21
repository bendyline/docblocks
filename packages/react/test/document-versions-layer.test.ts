import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DocumentSession,
  createFileSystemDocumentTarget,
  type DocumentSessionSnapshot,
} from '@bendyline/docblocks/document';
import {
  MemoryFileSystemProvider,
  conflictCopyScope,
  listConflictCopies,
  readConflictCopy,
  writeConflictCopy,
} from '@bendyline/docblocks/filesystem';
import {
  DocumentVersionsLayer,
  type DocumentVersionsLayerProps,
} from '../src/DocBlocksShell/DocumentVersionsLayer.js';

// Shell sources compile with the classic JSX transform under the test loader.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const DOCUMENT = 'Notes/Unicorns.md';
const SCOPE = conflictCopyScope(DOCUMENT)!;
const doc = (...paragraphs: string[]) => paragraphs.join('\n\n') + '\n';
const BASE = doc('# Unicorns', 'They are rare.', 'They like rainbows.');
const LOCAL = doc('# Unicorns', 'They are rare.', 'They like rainbows and glitter.');
const EXTERNAL = doc('# Unicorns', 'They are very rare.', 'They like rainbows.');
const MERGED = doc('# Unicorns', 'They are very rare.', 'They like rainbows and glitter.');

describe('DocumentVersionsLayer', () => {
  let provider: MemoryFileSystemProvider;
  let session: DocumentSession;
  let container: HTMLDivElement;
  let root: Root;
  let created: string[];
  let errors: string[];
  let counts: number[];
  let checkDocument: (() => Promise<void>) | undefined;

  async function wait(ms = 40): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  async function until(condition: () => boolean, label: string, attempts = 100): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (condition()) return;
      await wait(20);
    }
    throw new Error(`Timed out waiting for ${label}.`);
  }

  function props(snapshot: DocumentSessionSnapshot): DocumentVersionsLayerProps {
    return {
      provider,
      session,
      snapshot,
      documentPath: DOCUMENT,
      theme: 'light',
      checkDocument,
      onDocumentCreated: (path) => created.push(path),
      onCountChange: (count) => counts.push(count),
      onError: (message) => errors.push(message),
    };
  }

  /** Follows the session the way the shell does, so each snapshot re-renders the layer. */
  function Host() {
    const snapshot = React.useSyncExternalStore(session.subscribe, session.getSnapshot);
    return createElement(DocumentVersionsLayer, props(snapshot));
  }

  async function render(): Promise<void> {
    await act(async () => {
      root.render(createElement(Host));
    });
  }

  /** Type into the open document, as the editor would. */
  async function type(content: string): Promise<void> {
    await act(async () => {
      const snapshot = session.getSnapshot();
      session.edit(content, { targetKey: snapshot.targetKey!, generation: snapshot.generation });
    });
  }

  /** Another device or program saved a different version, and the app noticed. */
  async function savedElsewhere(content: string, savedBy?: string): Promise<void> {
    await provider.writeFile(DOCUMENT, content);
    await act(async () => {
      session.observeExternal({
        targetKey: session.getSnapshot().targetKey!,
        content,
        ...(savedBy ? { origin: { savedBy } } : {}),
      });
    });
  }

  function button(text: string): HTMLButtonElement | undefined {
    return [...document.body.querySelectorAll('button')].find((item) => item.textContent === text);
  }

  async function click(text: string): Promise<void> {
    const target = button(text);
    expect(target, `button "${text}"`).not.to.equal(undefined);
    await act(async () => target!.click());
  }

  const text = () => document.body.textContent ?? '';

  beforeEach(async () => {
    provider = new MemoryFileSystemProvider(`layer-${Date.now()}-${Math.random()}`, 'Layer');
    await provider.writeFile(DOCUMENT, BASE);
    session = new DocumentSession({ autoSaveEnabled: false, autoMergeIdleMs: 0 });
    await session.transitionTo(createFileSystemDocumentTarget(provider, DOCUMENT), BASE);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    created = [];
    errors = [];
    counts = [];
    checkDocument = undefined;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await session.cancel();
    await provider.v2.dispose();
  });

  it('shows nothing for a document with no other versions', async () => {
    await render();
    await wait();
    expect(container.textContent).to.equal('');
    expect(counts.at(-1)).to.equal(0);
  });

  it('says how many versions wait, and reports the count for the file row', async () => {
    await writeConflictCopy(provider, SCOPE, EXTERNAL, { origin: 'sync', label: 'Mac' });
    await writeConflictCopy(provider, SCOPE, LOCAL, { origin: 'local' });
    await render();
    await until(() => text().includes('2 other versions to review'), 'the notice');
    expect(counts.at(-1)).to.equal(2);
    expect(document.body.querySelector('[role="status"]')?.textContent).to.include('Review');
  });

  it('replaces the document with a chosen version and keeps what it replaced', async () => {
    await writeConflictCopy(provider, SCOPE, EXTERNAL, { origin: 'sync', label: 'Mac' });
    await render();
    await until(() => button('Review') !== undefined, 'the notice');
    await click('Review');
    await until(() => button('Use this version')?.disabled === false, 'the version to load');
    expect(text()).to.include('Saved on Mac');
    await click('Use this version');
    await until(() => session.getSnapshot().content === EXTERNAL, 'the replacement');

    expect(await provider.readFile(DOCUMENT)).to.equal(EXTERNAL);
    const left = await listConflictCopies(provider, SCOPE);
    expect(left.map((copy) => copy.origin)).to.deep.equal(['premerge']);
    expect(await readConflictCopy(provider, left[0]!)).to.equal(BASE);
    // Nothing is left to review, so the dialog and notice are gone.
    await until(() => !text().includes('Review other versions'), 'the dialog to close');
    expect(text()).not.to.include('to review');
    expect(errors).to.deep.equal([]);

    // Choosing a version is not a one-way door.
    expect(text()).to.include('The document now holds that version in place of your text.');
    await click('Undo');
    await until(() => session.getSnapshot().content === BASE, 'the undo');
    expect(await provider.readFile(DOCUMENT)).to.equal(BASE);
    await until(() => text().includes('1 other version to review'), 'the version to wait again');
    // It waits as a version the user turned down, which nothing clears by itself.
    const waiting = (await listConflictCopies(provider, SCOPE)).filter(
      (copy) => copy.origin !== 'premerge',
    );
    expect(waiting.map(({ origin, label }) => ({ origin, label }))).to.deep.equal([
      { origin: 'local', label: 'Mac' },
    ]);
    expect(await readConflictCopy(provider, waiting[0]!)).to.equal(EXTERNAL);
    await wait(200);
    expect(text()).to.include('1 other version to review');
    expect(errors).to.deep.equal([]);
  });

  it('discards a version without touching the document', async () => {
    await writeConflictCopy(provider, SCOPE, EXTERNAL, { origin: 'sync' });
    await writeConflictCopy(provider, SCOPE, LOCAL, { origin: 'local' });
    await render();
    await until(() => button('Review') !== undefined, 'the notice');
    await click('Review');
    await until(() => button('Discard the other version') !== undefined, 'the dialog');
    expect(document.body.querySelectorAll('.db-versions-picker option')).to.have.length(2);
    await click('Discard the other version');
    await until(() => text().includes('Another version of this document'), 'one version left');
    expect(await listConflictCopies(provider, SCOPE)).to.have.length(1);
    expect(session.getSnapshot().content).to.equal(BASE);
    expect(await provider.readFile(DOCUMENT)).to.equal(BASE);
  });

  it('keeps a version as its own document beside the original', async () => {
    await writeConflictCopy(provider, SCOPE, EXTERNAL, { origin: 'sync', label: 'Mac' });
    await render();
    await until(() => button('Review') !== undefined, 'the notice');
    await click('Review');
    await until(() => button('Keep both')?.disabled === false, 'the version to load');
    await click('Keep both');
    await until(() => created.length === 1, 'the new document');
    expect(created).to.deep.equal(['Notes/Unicorns (from Mac).md']);
    expect(await provider.readFile('Notes/Unicorns (from Mac).md')).to.equal(EXTERNAL);
    expect(await provider.readFile(DOCUMENT)).to.equal(BASE);
    expect(await listConflictCopies(provider, SCOPE)).to.deep.equal([]);
    expect(await provider.exists(SCOPE.directory)).to.equal(false);
  });

  it('keeps trying a version that cannot be read at first, as on busy synced storage', async () => {
    await writeConflictCopy(provider, SCOPE, EXTERNAL, { origin: 'sync', label: 'Mac' });
    // Reads of the copy are refused for a while, as native storage does when it is busy.
    let refusals = 0;
    const busyProvider = new Proxy(provider, {
      get(target, key, receiver) {
        if (key !== 'readBinary') return Reflect.get(target, key, receiver);
        return async (path: string) => {
          if (path.includes('/conflicts/') && refusals > 0) {
            refusals -= 1;
            throw new Error('Device storage is busy. Try again.');
          }
          return target.readBinary(path);
        };
      },
    });
    provider = busyProvider;
    await render();
    await until(() => button('Review') !== undefined, 'the notice');
    refusals = 2;
    await click('Review');
    // No dead end, and nothing for the user to do: it loads once storage answers.
    await until(() => button('Use this version')?.disabled === false, 'the version to load', 400);
    expect(refusals).to.equal(0);
    expect(text()).not.to.include('could not be opened');
  });

  it('stays out of the way while a save conflict needs a decision', async () => {
    await writeConflictCopy(provider, SCOPE, EXTERNAL, { origin: 'sync' });
    await render();
    await until(() => button('Review') !== undefined, 'the notice');
    await type(LOCAL);
    await savedElsewhere(doc('# Unicorns', 'They are rare.', 'They like rainbows, mostly.'));
    await wait();
    expect(session.getSnapshot().status).to.equal('conflict');
    expect(button('Review')).to.equal(undefined);
  });

  it('says when edits were combined, and Undo brings back the text from before', async () => {
    await render();
    await type(LOCAL);
    await savedElsewhere(EXTERNAL, "Mike's MacBook Pro");
    await until(() => session.getSnapshot().status === 'saved', 'the merged save');
    await until(() => text().includes('Safely combined your edits'), 'the merge notice');
    expect(text()).to.include("Safely combined your edits with changes from Mike's MacBook Pro.");
    expect(await provider.readFile(DOCUMENT)).to.equal(MERGED);

    await click('Undo');
    await until(() => session.getSnapshot().content === LOCAL, 'the undo');
    expect(await provider.readFile(DOCUMENT)).to.equal(LOCAL);
    // The other device's version is not lost with the merge: it waits for review.
    await until(() => text().includes('1 other version to review'), 'the kept version');
    // It is kept as a version the user turned down, not as one a sync service
    // set aside: that kind would only be combined again, here and elsewhere.
    const kept = await listConflictCopies(provider, SCOPE);
    expect(kept.filter((copy) => copy.origin === 'sync')).to.deep.equal([]);
    const waiting = kept.filter((copy) => copy.origin === 'local');
    expect(waiting).to.have.length(1);
    expect(waiting[0]!.label).to.equal("Mike's MacBook Pro");
    expect(await readConflictCopy(provider, waiting[0]!)).to.equal(EXTERNAL);
    expect(text()).not.to.include('combined your edits');
  });

  describe('a version the sync service set aside as saved at the same time', () => {
    const OVERLAP = doc('# Unicorns', 'They are rare.', 'They like rainbows, mostly.');
    /** Saved on the other device a moment after this document was opened here. */
    /**
     * A copy of a save made on this device carries the time of that save; a
     * version from another device was written a moment later. The session
     * tells the two apart by that time, not by the text alone.
     */
    const setAside = (content: string, label = "Mike's MacBook Pro") =>
      writeConflictCopy(provider, SCOPE, content, {
        origin: 'sync',
        label,
        capturedAt: label === 'This iPhone' ? Date.now() : Date.now() + 5_000,
      });

    async function typeAndSave(content: string): Promise<void> {
      await type(content);
      await act(async () => {
        await session.flush();
      });
    }

    it('is combined with the edits here without asking, and both texts are kept', async () => {
      await typeAndSave(LOCAL);
      await setAside(EXTERNAL);
      await render();
      await until(() => session.getSnapshot().content === MERGED, 'the merge');
      await until(() => text().includes('Safely combined your edits'), 'the merge notice');
      expect(text()).to.include("Safely combined your edits with changes from Mike's MacBook Pro.");
      await until(() => session.getSnapshot().status === 'saved', 'the merged save');
      expect(await provider.readFile(DOCUMENT)).to.equal(MERGED);

      // Nothing waits for review; both texts from before stay for a week.
      const kept = await listConflictCopies(provider, SCOPE);
      expect(kept.map((copy) => copy.origin)).to.deep.equal(['premerge', 'premerge']);
      const texts = await Promise.all(kept.map((copy) => readConflictCopy(provider, copy)));
      expect(texts.sort()).to.deep.equal([EXTERNAL, LOCAL].sort());
      expect(text()).not.to.include('to review');
      expect(counts.every((count) => count === 0)).to.equal(true);
      expect(errors).to.deep.equal([]);
    });

    it('stays apart after Undo, kept for review instead of being combined again', async () => {
      await typeAndSave(LOCAL);
      await setAside(EXTERNAL);
      await render();
      await until(() => text().includes('Safely combined your edits'), 'the merge notice');
      await click('Undo');
      await until(() => session.getSnapshot().content === LOCAL, 'the undo');
      await until(() => text().includes('1 other version to review'), 'the kept version');
      await wait(1_200);
      expect(session.getSnapshot().content).to.equal(LOCAL);
      expect(await provider.readFile(DOCUMENT)).to.equal(LOCAL);
      const waiting = (await listConflictCopies(provider, SCOPE)).filter(
        (copy) => copy.origin !== 'premerge',
      );
      expect(waiting.map(({ origin, label }) => ({ origin, label }))).to.deep.equal([
        { origin: 'local', label: "Mike's MacBook Pro" },
      ]);
    });

    it('keeps the save made here on screen when the other version became the document', async () => {
      await typeAndSave(LOCAL);
      const generation = session.getSnapshot().generation;
      // The sync service chose the other device's version as the file. It has
      // none of the typing here, so it is held for a moment, not swapped in.
      await savedElsewhere(EXTERNAL);
      expect(session.getSnapshot().content).to.equal(LOCAL);
      // The sync service kept this device's own save beside it: the two were
      // written at the same time, and are combined in one step.
      await setAside(LOCAL, 'This iPhone');
      await render();
      await until(() => session.getSnapshot().content === MERGED, 'the merge');
      expect(session.getSnapshot().generation).to.equal(generation + 1);
      await until(() => text().includes('Safely combined your edits'), 'the merge notice');
      expect(text()).to.include('Safely combined your edits with changes from another device.');
      await until(() => session.getSnapshot().status === 'saved', 'the merged save');
      expect(await provider.readFile(DOCUMENT)).to.equal(MERGED);
      // Its typing never left the document, so its set-aside copy is cleared.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const left = await listConflictCopies(provider, SCOPE);
        if (!left.some((copy) => copy.origin === 'sync')) break;
        await wait(20);
      }
      const left = await listConflictCopies(provider, SCOPE);
      expect(left.filter((copy) => copy.origin === 'sync')).to.deep.equal([]);
      expect(text()).not.to.include('to review');
    });

    it('combines without a conflict to resolve when the swap lands mid-typing', async () => {
      const FIRST = doc('# Unicorns', 'They are rare.', 'They like rainbows and');
      await typeAndSave(FIRST);
      // Still typing in the same paragraph when the other device's version lands.
      await type(LOCAL);
      await render();
      // A conflict the session is not about to settle itself is one the shell asks about.
      let asked = false;
      const stop = session.subscribe(() => {
        const conflict = session.getSnapshot().conflict;
        if (conflict && !conflict.merging) asked = true;
      });
      await savedElsewhere(EXTERNAL);
      // Measured from the last save this is a clash; the session waits to
      // hear whether the two were written at the same time before asking.
      expect(session.getSnapshot().conflict?.merging).to.equal(true);
      await setAside(FIRST, 'This iPhone');
      await until(() => session.getSnapshot().content === MERGED, 'the merge');
      await until(() => session.getSnapshot().status === 'saved', 'the merged save');
      expect(await provider.readFile(DOCUMENT)).to.equal(MERGED);
      expect(session.getSnapshot().conflict).to.equal(null);
      // Nobody was asked anything, and nothing is left to review.
      stop();
      expect(asked).to.equal(false);
      await until(() => text().includes('Safely combined your edits'), 'the merge notice');
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const left = await listConflictCopies(provider, SCOPE);
        if (!left.some((copy) => copy.origin === 'sync')) break;
        await wait(20);
      }
      expect(text()).not.to.include('to review');
    });

    it('lets every waiting version be heard while one of them has to wait', async () => {
      const FIRST = doc('# Unicorns', 'They are rare.', 'They like rainbows and');
      await typeAndSave(FIRST);
      await type(LOCAL);
      await savedElsewhere(EXTERNAL);
      // An unrelated version is listed first and cannot be dealt with while
      // the conflict is open; the one that settles the conflict comes after it.
      await writeConflictCopy(provider, SCOPE, OVERLAP, {
        origin: 'sync',
        label: "Mike's MacBook Pro",
        capturedAt: Date.now() + 9_000,
      });
      await setAside(FIRST, 'This iPhone');
      await render();
      await until(() => session.getSnapshot().content === MERGED, 'the merge', 60);
    });

    it('waits for review when both changed the same paragraph', async () => {
      await typeAndSave(LOCAL);
      await setAside(OVERLAP);
      await render();
      await until(() => text().includes('1 other version to review'), 'the notice');
      expect(session.getSnapshot().content).to.equal(LOCAL);
      expect(await provider.readFile(DOCUMENT)).to.equal(LOCAL);
      const kept = await listConflictCopies(provider, SCOPE);
      expect(kept.map((copy) => copy.origin)).to.deep.equal(['sync']);
    });

    it('offers a look at what was combined, with a way back to the text from before', async () => {
      await typeAndSave(LOCAL);
      await setAside(EXTERNAL);
      await render();
      await until(() => text().includes('Safely combined your edits'), 'the merge notice');
      // The kept texts have to be listed before there is anything to look at.
      await until(() => button('Review') !== undefined, 'the way to review');
      expect(text()).not.to.include('to review');
      await click('Review');
      await until(() => text().includes('Review combined versions'), 'the dialog');
      expect(text()).to.include('There is nothing you need to do');
      // Both sides of the merge are there: the text here, and the other device's.
      const options = [...document.body.querySelectorAll('.db-versions-picker option')].map(
        (option) => option.textContent ?? '',
      );
      expect(options).to.have.length(2);
      expect(options.some((option) => option.startsWith('Your text from before'))).to.equal(true);
      expect(
        options.some((option) => option.startsWith("The version from Mike's MacBook Pro")),
      ).to.equal(true);
      // Nothing is waiting to be thrown away: the kept texts expire by themselves.
      expect(button('Discard the other version')).to.equal(undefined);

      const picker = document.body.querySelector<HTMLSelectElement>('.db-versions-picker select')!;
      const mine = [...picker.options].find((option) =>
        (option.textContent ?? '').startsWith('Your text from before'),
      )!;
      await act(async () => {
        picker.value = mine.value;
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await until(() => button('Go back to this version')?.disabled === false, 'the text to load');
      await click('Go back to this version');
      await until(() => session.getSnapshot().content === LOCAL, 'the text from before');
      expect(await provider.readFile(DOCUMENT)).to.equal(LOCAL);
      expect(errors).to.deep.equal([]);
    });

    it('counts several merges in one calm notice', async () => {
      await typeAndSave(LOCAL);
      await setAside(EXTERNAL);
      await setAside(doc('# Unicorns!', 'They are rare.', 'They like rainbows.'), 'iPad');
      await render();
      await until(
        () => text().includes('Safely combined your edits with 2 other versions.'),
        'the counted notice',
      );
      expect(session.getSnapshot().content).to.equal(
        doc('# Unicorns!', 'They are very rare.', 'They like rainbows and glitter.'),
      );
      // There is no single "before" to go back to; Review has every kept text.
      expect(button('Undo')).to.equal(undefined);
      await until(() => button('Review') !== undefined, 'the way to review');
      expect(text()).not.to.include('to review');
    });

    it('stops asking about a version once the document has caught up with it', async () => {
      await typeAndSave(LOCAL);
      await setAside(OVERLAP);
      await render();
      await until(() => text().includes('1 other version to review'), 'the notice');
      // The same text then arrives as the document itself.
      await savedElsewhere(OVERLAP);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await listConflictCopies(provider, SCOPE)).length === 0) break;
        await wait(20);
      }
      expect(await listConflictCopies(provider, SCOPE)).to.deep.equal([]);
      await until(() => !text().includes('to review'), 'the notice to go');
      expect(session.getSnapshot().content).to.equal(OVERLAP);
    });

    it('is cleared away when the document already holds exactly that text', async () => {
      await typeAndSave(LOCAL);
      await setAside(LOCAL);
      await render();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await listConflictCopies(provider, SCOPE)).length === 0) break;
        await wait(20);
      }
      expect(await listConflictCopies(provider, SCOPE)).to.deep.equal([]);
      expect(session.getSnapshot().content).to.equal(LOCAL);
      expect(text()).not.to.include('to review');
      expect(text()).not.to.include('ombined');
    });

    it('is not cleared as already here before the session has seen what replaced it', async () => {
      await typeAndSave(LOCAL);
      // The sync service made the other device's version the file and set
      // this device's save aside, and the set-aside copy is noticed first:
      // the session still believes its own save is the document.
      await provider.writeFile(DOCUMENT, EXTERNAL);
      await setAside(LOCAL, 'This iPhone');
      let checks = 0;
      checkDocument = async () => {
        checks += 1;
        session.observeExternal({
          targetKey: session.getSnapshot().targetKey!,
          content: await provider.readFile(DOCUMENT),
        });
      };
      await render();
      await until(() => session.getSnapshot().content === MERGED, 'the save to be put back');
      await until(() => session.getSnapshot().status === 'saved', 'the merged save');
      expect(checks).to.be.greaterThan(0);
      expect(await provider.readFile(DOCUMENT)).to.equal(MERGED);
      // The text was put back, so the copy is no longer the only place it lives.
      const left = await listConflictCopies(provider, SCOPE);
      expect(left.filter((copy) => copy.origin === 'sync')).to.deep.equal([]);
      expect(text()).not.to.include('to review');
    });

    it('is cleared when the same text is already kept from before a merge', async () => {
      await typeAndSave(LOCAL);
      await setAside(OVERLAP);
      await render();
      await until(() => text().includes('1 other version to review'), 'the notice');
      // Another device combined that version and kept it, as every merge does.
      await writeConflictCopy(provider, SCOPE, OVERLAP, {
        origin: 'premerge',
        label: "Mike's MacBook Pro",
      });
      const waiting = async () =>
        (await listConflictCopies(provider, SCOPE)).filter((copy) => copy.origin === 'sync');
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await waiting()).length === 0) break;
        await wait(20);
      }
      expect(await waiting()).to.deep.equal([]);
      await until(() => !text().includes('to review'), 'the notice to go');
      expect(session.getSnapshot().content).to.equal(LOCAL);
      // The kept text is still there for anyone who wants it back.
      expect((await listConflictCopies(provider, SCOPE)).map((copy) => copy.origin)).to.deep.equal([
        'premerge',
      ]);
    });

    it('clears a leftover the document has grown past, and keeps one with words of its own', async () => {
      await typeAndSave(MERGED);
      const hourAgo = Date.now() - 3_600_000;
      // Older than anything this session remembers, as after a restart.
      await writeConflictCopy(provider, SCOPE, EXTERNAL, {
        origin: 'sync',
        label: "Mike's MacBook Pro",
        capturedAt: hourAgo,
      });
      await writeConflictCopy(provider, SCOPE, OVERLAP, {
        origin: 'sync',
        label: "Mike's MacBook Pro",
        capturedAt: hourAgo + 1_000,
      });
      await render();
      await until(() => text().includes('1 other version to review'), 'the notice');
      const left = await listConflictCopies(provider, SCOPE);
      expect(left).to.have.length(1);
      expect(await readConflictCopy(provider, left[0]!)).to.equal(OVERLAP);
      expect(session.getSnapshot().content).to.equal(MERGED);
      expect(text()).not.to.include('ombined');
    });

    it('is not combined while the user is still typing', async () => {
      await session.cancel();
      session = new DocumentSession({ autoSaveEnabled: false, autoMergeIdleMs: 400 });
      await session.transitionTo(createFileSystemDocumentTarget(provider, DOCUMENT), BASE);
      await type(LOCAL);
      await setAside(EXTERNAL);
      await render();
      await wait(100);
      expect(session.getSnapshot().content).to.equal(LOCAL);
      // Hidden while it waits its turn, not shown as something to decide.
      expect(text()).not.to.include('to review');
      await until(() => session.getSnapshot().content === MERGED, 'the merge after a pause', 200);
    });
  });

  it('withdraws Undo once the combined text has been edited', async () => {
    await render();
    await type(LOCAL);
    await savedElsewhere(EXTERNAL);
    await until(() => text().includes('Safely combined your edits'), 'the merge notice');
    expect(text()).to.include('changes from another device');
    expect(button('Undo')).not.to.equal(undefined);
    await type(`${MERGED}\nMore.\n`);
    await wait();
    expect(button('Undo')).to.equal(undefined);
    await click('Dismiss');
    expect(text()).not.to.include('combined your edits');
  });

  it('tells the user their unsaved text was set aside when they leave a conflict', async () => {
    await render();
    await type(LOCAL);
    await savedElsewhere(doc('# Unicorns', 'They are rare.', 'They like rainbows, mostly.'));
    await act(async () => {
      await session.transitionTo(null, '');
    });
    await until(() => text().includes('was set aside'), 'the notice');
    expect(text()).to.include('Your unsaved version of Unicorns.md was set aside.');
  });
});
