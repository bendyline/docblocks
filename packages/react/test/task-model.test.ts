import { expect } from 'chai';
import { parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import type { IndexedDocument, IndexedFolderMarker } from '@bendyline/docblocks/workspace-index';
import {
  buildTaskBoard,
  categoryHue,
  dueLabel,
  kindFoldersFromMarkers,
  sectionTasks,
  taskItemsFromDocuments,
} from '../src/Tasks/task-model.js';

const p = parseWorkspacePath;
const TODAY = '2026-11-23';

function doc(path: string, fields: Partial<IndexedDocument> = {}): IndexedDocument {
  return {
    path: p(path),
    sourcePath: p(path),
    format: 'markdown',
    lastModified: '2026-11-20T10:00:00.000Z',
    title: fields.title ?? path.replace(/^.*\//, '').replace(/\.md$/, ''),
    outline: [],
    wordCount: 1,
    content: 'full',
    ...fields,
  };
}

const markers: IndexedFolderMarker[] = [
  { path: p('Tasks'), status: 'ok', settings: { version: 1, kind: 'tasks' }, version: null },
  { path: p('Journal'), status: 'ok', settings: { version: 1, kind: 'journal' }, version: null },
  { path: p('Broken'), status: 'invalid', settings: null, version: null },
  {
    path: p('Work/Tasks'),
    status: 'unreadable',
    settings: { version: 1, kind: 'tasks' },
    version: null,
  },
];

const documents = [
  doc('Tasks/Active/Book dentist.md', { title: 'A heading', due: '2026-11-23', category: 'Home' }),
  doc('Tasks/Active/Renew passport.md', { due: '2026-12-05', checklist: { done: 1, total: 3 } }),
  doc('Tasks/Waiting/Refund.md', { due: '2026-11-21' }),
  doc('Tasks/Active/No date.md'),
  doc('Tasks/Done/Pay bill.md', { completed: '2026-11-20' }),
  // Dragged out of Done in Finder: the folder says open, whatever the stamp says.
  doc('Tasks/Active/Dragged back.md', { completed: '2026-11-19' }),
  doc('Clients/Proposal.md', { title: 'Proposal for Acme', due: '2026-11-24' }),
  // Done with no date given: dated by when the file last changed.
  doc('Clients/Old.md', { completed: true, lastModified: '2026-11-01T09:00:00.000Z' }),
  doc('Clients/Plain.md'),
  doc('Journal/2026/2026-11-23.md', { due: '2026-11-23' }),
  doc('Work/Tasks/Active/Ship.md'),
];

describe('task model', () => {
  const folders = kindFoldersFromMarkers(markers);
  const items = taskItemsFromDocuments('ws', documents, folders);
  const byPath = new Map(items.map((item) => [item.path, item]));

  it('uses folders whose settings hold, including one that could not be re-read', () => {
    expect(folders.map((folder) => folder.path)).to.deep.equal(['Tasks', 'Journal', 'Work/Tasks']);
  });

  it('finds tasks in tasks folders, and dated documents elsewhere', () => {
    expect([...byPath.keys()].sort()).to.deep.equal(
      [
        'Clients/Old.md',
        'Clients/Proposal.md',
        'Journal/2026/2026-11-23.md',
        'Tasks/Active/Book dentist.md',
        'Tasks/Active/Dragged back.md',
        'Tasks/Active/No date.md',
        'Tasks/Active/Renew passport.md',
        'Tasks/Done/Pay bill.md',
        'Tasks/Waiting/Refund.md',
        'Work/Tasks/Active/Ship.md',
      ].sort(),
    );
    // A task is called by its file name; a document elsewhere keeps its title.
    expect(byPath.get(p('Tasks/Active/Book dentist.md'))?.title).to.equal('Book dentist');
    expect(byPath.get(p('Clients/Proposal.md'))).to.include({
      title: 'Proposal for Acme',
      folder: null,
      bucket: null,
      done: false,
    });
    expect(byPath.get(p('Tasks/Active/Dragged back.md'))?.done).to.equal(false);
    expect(byPath.get(p('Tasks/Done/Pay bill.md'))).to.include({
      done: true,
      completedOn: '2026-11-20',
    });
    expect(byPath.get(p('Clients/Old.md'))).to.include({ done: true });
  });

  it('sorts tasks into what needs attention', () => {
    const sections = sectionTasks(items, TODAY);
    const paths = (list: readonly { path: string }[]) => list.map((item) => item.path);
    expect(paths(sections.overdue)).to.deep.equal(['Tasks/Waiting/Refund.md']);
    // Same day: by name, and a journal entry is named for its date.
    expect(paths(sections.today)).to.deep.equal([
      'Journal/2026/2026-11-23.md',
      'Tasks/Active/Book dentist.md',
    ]);
    expect(paths(sections.upcoming)).to.deep.equal([
      'Clients/Proposal.md',
      'Tasks/Active/Renew passport.md',
    ]);
    expect(paths(sections.undated)).to.deep.equal([
      'Tasks/Active/Dragged back.md',
      'Tasks/Active/No date.md',
      'Work/Tasks/Active/Ship.md',
    ]);
    expect(paths(sections.done)).to.deep.equal(['Tasks/Done/Pay bill.md', 'Clients/Old.md']);
  });

  it('lays a tasks folder out as columns: default bucket first, others, then Done', () => {
    const board = buildTaskBoard(
      folders[0]!,
      [
        'Tasks',
        'Tasks/Active',
        'Tasks/Waiting',
        'Tasks/Someday',
        'Tasks/Done',
        'Tasks/Active/House',
        'Clients',
      ],
      items,
    );
    expect(
      board.columns.map((column) => [column.bucket, column.done, column.items.length]),
    ).to.deep.equal([
      ['Active', false, 4],
      ['Someday', false, 0],
      ['Waiting', false, 1],
      ['Done', true, 1],
    ]);
    expect(board.openCount).to.equal(5);
    expect(board.columns[0]!.items.map((item) => item.title)).to.deep.equal([
      'Book dentist',
      'Renew passport',
      'Dragged back',
      'No date',
    ]);
    const empty = buildTaskBoard(folders[2]!, ['Work', 'Work/Tasks'], []);
    expect(empty.columns.map((column) => [column.bucket, column.exists])).to.deep.equal([
      ['Active', false],
      ['Done', false],
    ]);
  });

  it('labels due dates the way a person would say them', () => {
    expect(dueLabel('2026-11-23', TODAY)).to.deep.equal({ text: 'Today', status: 'today' });
    expect(dueLabel('2026-11-23T15:30', TODAY).text).to.equal('Today, 15:30');
    expect(dueLabel('2026-11-24', TODAY)).to.deep.equal({ text: 'Tomorrow', status: 'tomorrow' });
    expect(dueLabel('2026-11-22', TODAY)).to.deep.equal({ text: 'Yesterday', status: 'overdue' });
    expect(dueLabel('2026-11-20', TODAY)).to.deep.equal({ text: '3 days late', status: 'overdue' });
    expect(dueLabel('2026-11-27', TODAY, 'en-GB').text).to.equal('Fri 27 Nov');
    expect(dueLabel('2026-12-25', TODAY, 'en-GB').text).to.equal('25 Dec');
    expect(dueLabel('2027-01-09', TODAY, 'en-GB').text).to.equal('9 Jan 2027');
  });

  it('gives a category the same colour everywhere', () => {
    expect(categoryHue('Home')).to.equal(categoryHue(' home '));
    const hues = new Set(['Home', 'Work', 'Money', 'Family', 'Clients', 'Health'].map(categoryHue));
    expect(hues.size).to.be.greaterThan(2);
  });
});
