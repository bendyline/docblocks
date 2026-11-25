import { expect } from 'chai';
import { MemoryFileSystemProviderV2 } from '@bendyline/docblocks/filesystem/memory';
import {
  FsError,
  parseWorkspacePath,
  type FileSystemProvider,
} from '@bendyline/docblocks/filesystem';
import { createWorkspaceIndex, type WorkspaceIndex } from '@bendyline/docblocks/workspace-index';
import { readDocumentProperties } from '@bendyline/docblocks/properties';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { createPageActions, describeActionError, noteTitleFor } from '../src/Home/page-actions.js';
import { createProviderTaskGateway } from '../src/Tasks/task-operations.js';
import { kindFoldersFromMarkers, taskItemsFromDocuments } from '../src/Tasks/task-model.js';

const p = parseWorkspacePath;
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array) => new TextDecoder().decode(data);
let sequence = 0;

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function setUp(files: Record<string, string> = {}) {
  const v2 = new MemoryFileSystemProviderV2(`page-${++sequence}`, 'Pages');
  for (const [path, text] of Object.entries(files)) {
    await v2.writeFile(p(path), encode(text), { createParents: true });
  }
  const index: WorkspaceIndex = createWorkspaceIndex({
    workspaceId: 'w',
    source: {
      stat: (x) => v2.stat(x),
      readFile: (x) => v2.readFile(x),
      readDirectory: (x) => v2.readDirectory(x),
      capabilities: { watch: false },
    },
    yieldControl: () => Promise.resolve(),
    changeCoalesceMs: 0,
    minRefreshIntervalMs: 0,
  });
  index.start();
  const settled = () => index.getStatus().phase === 'ready';
  await waitFor(settled, 'index');
  const reports: string[] = [];
  const opened: string[] = [];
  let confirmAnswer = true;
  const actions = createPageActions({
    gateway: createProviderTaskGateway({ v2 } as unknown as FileSystemProvider),
    storage: v2,
    kindFolders: () => kindFoldersFromMarkers(index.getFolderMarkers()),
    documentPaths: () => index.getDocuments().map((document) => document.path),
    today: () => '2026-11-23',
    now: () => new Date(2026, 10, 23, 9, 5),
    confirmDelete: async () => confirmAnswer,
    report: (kind, message) => reports.push(`${kind}: ${message}`),
    changed: (path) => (path ? index.invalidate(path) : index.refresh({ force: true })),
    openDocument: (path) => opened.push(`doc ${path}`),
    openFolder: (path) => opened.push(`folder ${path}`),
  });
  /** A fresh walk has finished and everything it found is analyzed. */
  const caughtUp = async () => {
    const before = index.getStatus().generation;
    index.refresh({ force: true });
    await waitFor(() => index.getStatus().generation > before && settled(), 'index to catch up');
  };
  const read = async (path: string) => {
    const file = await v2.readFile(p(path));
    return file ? decode(file.data) : null;
  };
  return {
    v2,
    index,
    actions,
    reports,
    opened,
    caughtUp,
    read,
    setConfirm: (answer: boolean) => (confirmAnswer = answer),
  };
}

describe('page actions', () => {
  it('sets up a tasks folder on the first task, then adds to it', async () => {
    const ws = await setUp({ 'Notes/a.md': '# A\n' });
    const first = await ws.actions.addTask('Call Priya tomorrow');
    expect(first).to.equal('Tasks/Active/Call Priya.md');
    expect(await ws.read('Tasks/.docblocks/folder.json')).to.include('"kind": "tasks"');
    expect((await ws.v2.stat(p('Tasks/Done')))?.kind).to.equal('directory');
    expect(
      readDocumentProperties(parseMarkdown((await ws.read(first!))!).frontmatter),
    ).to.deep.equal({
      due: '2026-11-24',
    });
    await ws.caughtUp();
    expect(ws.actions.defaultTasksFolder()?.path).to.equal('Tasks');

    const second = await ws.actions.addTask('Pay rent', { folder: '/Tasks', bucket: 'Waiting' });
    expect(second).to.equal('Tasks/Waiting/Pay rent.md');
    expect(await ws.actions.addTask('   ')).to.equal(null);
    ws.index.dispose();
  });

  it('starts a new tasks folder where asked, beside any that exist', async () => {
    const ws = await setUp({
      'Tasks/.docblocks/folder.json': '{"version":1,"kind":"tasks"}',
      'Projects/Garden/Plan.md': '# Plan\n',
    });
    await ws.caughtUp();
    // Unlike setting one up from Home, the gallery always makes a new list.
    expect(await ws.actions.createKindFolder('/Projects/Garden', 'tasks')).to.equal(
      'Projects/Garden/Tasks',
    );
    expect(await ws.read('Projects/Garden/Tasks/.docblocks/folder.json')).to.include(
      '"kind": "tasks"',
    );
    expect((await ws.v2.stat(p('Projects/Garden/Tasks/Active')))?.kind).to.equal('directory');
    expect((await ws.v2.stat(p('Projects/Garden/Tasks/Done')))?.kind).to.equal('directory');
    expect(await ws.actions.createKindFolder('', 'tasks')).to.equal('Tasks 2');
    expect(ws.opened).to.deep.equal(['folder /Projects/Garden/Tasks', 'folder /Tasks 2']);
    expect(ws.reports).to.deep.equal([
      'success: Set up Projects › Garden › Tasks as a tasks folder.',
      'success: Set up Tasks 2 as a tasks folder.',
    ]);
    ws.index.dispose();
  });

  it('finishes and reopens the tasks the pages show', async () => {
    const ws = await setUp({
      'Tasks/.docblocks/folder.json': '{"version":1,"kind":"tasks"}',
      'Tasks/Active/Paint.md': '---\ndue: 2026-11-23\n---\n',
    });
    const items = () =>
      taskItemsFromDocuments(
        'w',
        ws.index.getDocuments(),
        kindFoldersFromMarkers(ws.index.getFolderMarkers()),
      );
    const [paint] = items();
    await ws.actions.complete(paint!);
    await ws.caughtUp();
    const done = items().find((item) => item.title === 'Paint');
    expect(done).to.include({ path: 'Tasks/Done/Paint.md', done: true, completedOn: '2026-11-23' });
    await ws.actions.reopen(done!);
    await ws.caughtUp();
    expect(items()[0]).to.include({ path: 'Tasks/Active/Paint.md', done: false });
    await ws.actions.moveToBucket(items()[0]!, 'Someday');
    expect(await ws.read('Tasks/Someday/Paint.md')).to.not.equal(null);
    ws.index.dispose();
  });

  it('sets up each kind of folder once, under a free name, and opens it', async () => {
    const ws = await setUp({ 'Journal/old.md': 'an ordinary folder already called Journal' });
    expect(await ws.actions.setUp('journal')).to.equal('Journal 2');
    await ws.caughtUp();
    // Asking again finds the one already set up.
    expect(await ws.actions.setUp('journal')).to.equal('Journal 2');
    expect(await ws.actions.setUp('unfiled')).to.equal('Unfiled');
    expect(ws.opened).to.deep.equal(['folder /Journal 2', 'folder /Journal 2', 'folder /Unfiled']);
    ws.index.dispose();
  });

  it('turns an existing folder into a kind folder and back without touching its files', async () => {
    const ws = await setUp({ 'Projects/plan.md': '# Plan\n' });
    await ws.actions.makeKind('/Projects', 'tasks');
    await ws.caughtUp();
    expect(ws.index.getFolderMarkers().map((marker) => marker.path)).to.deep.equal(['Projects']);
    expect(await ws.read('Projects/plan.md')).to.equal('# Plan\n');
    await ws.actions.clearKind('/Projects');
    await ws.caughtUp();
    expect(ws.index.getFolderMarkers()).to.deep.equal([]);
    expect(await ws.read('Projects/plan.md')).to.equal('# Plan\n');
    expect((await ws.v2.stat(p('Projects/Active')))?.kind).to.equal('directory');
    ws.index.dispose();
  });

  it('adds buckets with valid names only', async () => {
    const ws = await setUp({ 'Tasks/.docblocks/folder.json': '{"version":1,"kind":"tasks"}' });
    expect(await ws.actions.addBucket('/Tasks', ' Someday ')).to.equal(true);
    expect((await ws.v2.stat(p('Tasks/Someday')))?.kind).to.equal('directory');
    expect(await ws.actions.addBucket('/Tasks', 'a/b')).to.equal(false);
    expect(await ws.actions.addBucket('/Tasks', 'Someday')).to.equal(false);
    expect(ws.reports.filter((report) => report.startsWith('error'))).to.have.length(2);
    ws.index.dispose();
  });

  it('opens a journal day, creating its entry once', async () => {
    const ws = await setUp({ 'Journal/.docblocks/folder.json': '{"version":1,"kind":"journal"}' });
    await ws.actions.openJournalDay('/Journal', '2026-11-23');
    expect(ws.opened).to.deep.equal(['doc /Journal/2026/2026-11-23.md']);
    expect(await ws.read('Journal/2026/2026-11-23.md')).to.match(
      /^# Monday,? (23 November|November 23),? 2026\n\n$/,
    );
    await ws.v2.writeFile(p('Journal/2026/2026-11-23.md'), encode('# Kept\n'));
    await ws.caughtUp();
    await ws.actions.openJournalDay('/Journal', '2026-11-23');
    expect(await ws.read('Journal/2026/2026-11-23.md')).to.equal('# Kept\n');
    ws.index.dispose();
  });

  it("adds timestamped lines to today's journal entry, setting the journal up if needed", async () => {
    const ws = await setUp({});
    expect(await ws.actions.appendToJournal('Coffee with Sam')).to.equal(true);
    await ws.caughtUp();
    expect(await ws.actions.appendToJournal('  Walked\nthe dog ')).to.equal(true);
    const entry = await ws.read('Journal/2026/2026-11-23.md');
    expect(entry).to.match(/\n\n- 09:05 Coffee with Sam\n- 09:05 Walked the dog\n$/);
    expect(await ws.actions.appendToJournal('  ')).to.equal(false);
    ws.index.dispose();
  });

  it('keeps lines and attachments under one journal bullet when asked', async () => {
    const ws = await setUp({});
    expect(await ws.actions.appendToJournal('Coffee with Sam')).to.equal(true);
    await ws.caughtUp();
    expect(
      await ws.actions.appendToJournal('Site visit\n\n  - roof is fine\nmore later  ', {
        keepLines: true,
        attachments: [new File(['png'], 'roof photo.png', { type: 'image/png' })],
      }),
    ).to.equal(true);
    // A plain line after a kept-lines entry still joins the same tight list.
    expect(await ws.actions.appendToJournal('Home')).to.equal(true);
    const entry = await ws.read('Journal/2026/2026-11-23.md');
    // Further lines are nested bullets (a typed list item keeps its marker),
    // the shape Squisq's editor keeps inside the entry's item.
    expect(entry).to.match(
      /\n\n- 09:05 Coffee with Sam\n- 09:05 Site visit\n {4}- roof is fine\n {2}- more later\n {2}- !\[roof photo\]\(<2026-11-23_files\/roof photo\.png>\)\n- 09:05 Home\n$/,
    );
    expect(await ws.read('Journal/2026/2026-11-23_files/roof photo.png')).to.equal('png');
    ws.index.dispose();
  });

  it('writes no journal line when an attachment cannot be kept', async () => {
    const ws = await setUp({});
    const broken = {
      name: 'broken.png',
      type: 'image/png',
      arrayBuffer: () => Promise.reject(new Error('The file could not be read.')),
    };
    const fine = new File(['png'], 'fine.png', { type: 'image/png' });
    expect(
      await ws.actions.appendToJournal('Lost', { keepLines: true, attachments: [fine, broken] }),
    ).to.equal(false);
    expect(await ws.read('Journal/2026/2026-11-23.md')).to.equal(null);
    expect(await ws.v2.stat(p('Journal/2026/2026-11-23_files/fine.png'))).to.equal(null);
    expect(ws.reports.at(-1)).to.equal(
      "error: Couldn't add that to your journal. The file could not be read.",
    );
    ws.index.dispose();
  });

  it('saves a note with its files beside it, or with files alone', async () => {
    const ws = await setUp({});
    const shot = () => new File(['png'], 'image.png', { type: 'image/png' });
    const note = await ws.actions.saveNote('Venue ideas\n\nThe barn.', 'Venue ideas', [
      shot(),
      shot(),
      new File(['%PDF'], 'quote.pdf', { type: 'application/pdf' }),
    ]);
    expect(note).to.equal('Unfiled/Venue ideas.md');
    expect(await ws.read(note!)).to.equal(
      'Venue ideas\n\nThe barn.\n\n![image](<Venue ideas_files/image.png>)\n\n' +
        '![image (2)](<Venue ideas_files/image (2).png>)\n\n[quote.pdf](<Venue ideas_files/quote.pdf>)\n',
    );
    expect(await ws.read('Unfiled/Venue ideas_files/image (2).png')).to.equal('png');

    const alone = await ws.actions.saveNote('', undefined, [
      new File(['png'], 'Receipt.PNG', { type: '' }),
    ]);
    expect(alone).to.equal('Unfiled/Receipt.md');
    expect(await ws.read(alone!)).to.equal('![Receipt](Receipt_files/Receipt.png)\n');
    expect(await ws.actions.saveNote('  ', undefined, [])).to.equal(null);
    ws.index.dispose();
  });

  it('attaches files to an existing document, all or nothing', async () => {
    const ws = await setUp({ 'Tasks/Active/Call Priya.md': '---\ndue: 2026-11-24\n---\n' });
    expect(
      await ws.actions.attach('Tasks/Active/Call Priya.md', [
        new File(['png'], 'venue.png', { type: 'image/png' }),
      ]),
    ).to.equal(true);
    expect(await ws.read('Tasks/Active/Call Priya.md')).to.equal(
      '---\ndue: 2026-11-24\n---\n\n![venue](<Call Priya_files/venue.png>)\n',
    );

    const broken = {
      name: 'b.png',
      type: 'image/png',
      arrayBuffer: () => Promise.reject(new TypeError('NotReadableError')),
    };
    expect(
      await ws.actions.attach('Tasks/Active/Call Priya.md', [
        new File(['png'], 'second.png', { type: 'image/png' }),
        broken,
      ]),
    ).to.equal(false);
    expect(await ws.v2.stat(p('Tasks/Active/Call Priya_files/second.png'))).to.equal(null);
    expect(await ws.read('Tasks/Active/Call Priya.md')).to.not.include('second');
    expect(ws.reports.at(-1)).to.equal(
      "error: Couldn't attach those 2 files. Something went wrong. Try again.",
    );
    expect(await ws.actions.attach('Tasks/Active/Call Priya.md', [])).to.equal(true);
    ws.index.dispose();
  });

  it('saves notes to the Unfiled drawer and files them away', async () => {
    const ws = await setUp({ 'Clients/Acme/brief.md': '# Brief\n' });
    const note = await ws.actions.saveNote('# Acme pricing thoughts\n\nThree tiers.');
    expect(note).to.equal('Unfiled/Acme pricing thoughts.md');
    expect(await ws.read(note!)).to.equal('# Acme pricing thoughts\n\nThree tiers.\n');
    expect(await ws.actions.saveNote('# Acme pricing thoughts\n\nAgain.')).to.equal(
      'Unfiled/Acme pricing thoughts (2).md',
    );
    await ws.v2.writeFile(p('Unfiled/Acme pricing thoughts_files/chart.png'), encode('png'), {
      createParents: true,
    });
    await ws.actions.fileTo(note!, '/Clients/Acme');
    expect(await ws.read('Clients/Acme/Acme pricing thoughts.md')).to.not.equal(null);
    expect(await ws.read('Clients/Acme/Acme pricing thoughts_files/chart.png')).to.equal('png');

    await ws.caughtUp();
    await ws.actions.makeTask('Unfiled/Acme pricing thoughts (2).md');
    expect(await ws.read('Tasks/Active/Acme pricing thoughts (2).md')).to.include('Again.');
    ws.index.dispose();
  });

  it('deletes only after a yes, taking the media folder with it', async () => {
    const ws = await setUp({
      'Unfiled/scan.md': 'x',
      'Unfiled/scan_files/page.png': 'png',
      'Unfiled/receipt.pdf': '%PDF',
    });
    ws.setConfirm(false);
    await ws.actions.remove('Unfiled/scan.md');
    expect(await ws.read('Unfiled/scan.md')).to.equal('x');
    ws.setConfirm(true);
    await ws.actions.remove('Unfiled/scan.md');
    expect(await ws.v2.stat(p('Unfiled/scan.md'))).to.equal(null);
    expect(await ws.v2.stat(p('Unfiled/scan_files'))).to.equal(null);
    await ws.actions.makeTask('Unfiled/receipt.pdf');
    expect(ws.reports.at(-1)).to.match(/^error: Only a note can become a task/);
    ws.index.dispose();
  });

  it('names notes from their first line and explains failures in plain words', () => {
    expect(noteTitleFor('\n\n## Meeting notes 20 Nov\nPriya wants the invoice.')).to.equal(
      'Meeting notes 20 Nov',
    );
    expect(noteTitleFor('one two three four five six seven eight nine ten')).to.equal(
      'one two three four five six seven eight…',
    );
    expect(describeActionError(new FsError('conflict', 'ETAG mismatch 0x8f', {}))).to.equal(
      'It changed somewhere else in the meantime. Try again.',
    );
    expect(describeActionError(new TypeError('Failed to execute writeFile on handle'))).to.equal(
      'Something went wrong. Try again.',
    );
    expect(describeActionError(new Error('That task is no longer there.'))).to.equal(
      'That task is no longer there.',
    );
  });
});
