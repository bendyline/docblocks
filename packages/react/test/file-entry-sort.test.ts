import { expect } from 'chai';
import type { FileSystemEntry } from '@bendyline/docblocks/filesystem';
import { sortFileEntries } from '../src/FileExplorer/entry-sort.js';

function file(name: string, lastModified?: string): FileSystemEntry {
  return { kind: 'file', name, path: name, lastModified };
}

function directory(name: string): FileSystemEntry {
  return { kind: 'directory', name, path: name };
}

describe('file explorer entry sorting', () => {
  it('keeps the current directory-first alphabetical name order', () => {
    const entries = [file('z.md'), directory('z-folder'), file('a.md'), directory('a-folder')];

    expect(sortFileEntries(entries, 'name').map((entry) => entry.name)).to.deep.equal([
      'a-folder',
      'z-folder',
      'a.md',
      'z.md',
    ]);
  });

  it('keeps folders alphabetical and sorts timestamped files newest first', () => {
    const entries = [
      file('old.md', '2026-07-20T10:00:00.000Z'),
      directory('z-folder'),
      file('new.md', '2026-07-22T10:00:00.000Z'),
      directory('a-folder'),
    ];

    expect(sortFileEntries(entries, 'last-modified').map((entry) => entry.name)).to.deep.equal([
      'a-folder',
      'z-folder',
      'new.md',
      'old.md',
    ]);
  });

  it('uses name order for equal, missing, or invalid timestamps', () => {
    const entries = [
      file('missing-z.md'),
      file('equal-z.md', '2026-07-22T10:00:00.000Z'),
      file('invalid.md', 'not-a-date'),
      file('equal-a.md', '2026-07-22T10:00:00.000Z'),
      file('missing-a.md'),
    ];

    expect(sortFileEntries(entries, 'last-modified').map((entry) => entry.name)).to.deep.equal([
      'equal-a.md',
      'equal-z.md',
      'invalid.md',
      'missing-a.md',
      'missing-z.md',
    ]);
  });

  it('orders names the way people read them: ignoring case, numbers by value', () => {
    // Regression: a code-unit comparison listed these as
    // Invoice 10 · Invoice 2 · aboutDocBlocks · apple orchard estimate · newsletter.
    const entries = [
      file('Invoice 10.md'),
      file('Invoice 2.md'),
      file('aboutDocBlocks.md'),
      file('apple orchard estimate.md'),
      file('newsletter.md'),
    ];

    expect(sortFileEntries(entries, 'name').map((entry) => entry.name)).to.deep.equal([
      'aboutDocBlocks.md',
      'apple orchard estimate.md',
      'Invoice 2.md',
      'Invoice 10.md',
      'newsletter.md',
    ]);
  });

  it('sorts folders by the same rules', () => {
    const entries = [directory('Clients 10'), directory('archive'), directory('clients 2')];

    expect(sortFileEntries(entries, 'name').map((entry) => entry.name)).to.deep.equal([
      'archive',
      'clients 2',
      'Clients 10',
    ]);
  });

  it('compares the titles the list shows, so "notes" comes before "notes 2"', () => {
    const entries = [file('notes 2.md'), file('notes.md'), file('notes.docx')];

    // `.md` is hidden; a raw comparison put "notes 2.md" first (space < dot).
    expect(sortFileEntries(entries, 'name').map((entry) => entry.name)).to.deep.equal([
      'notes.md',
      'notes 2.md',
      'notes.docx',
    ]);
  });

  it('gives names that differ only in case a fixed order', () => {
    const forward = sortFileEntries([file('b.md'), file('B.md')], 'name');
    const backward = sortFileEntries([file('B.md'), file('b.md')], 'name');

    expect(forward.map((entry) => entry.name)).to.deep.equal(backward.map((entry) => entry.name));
  });

  it('does not mutate provider-owned listing arrays', () => {
    const entries = [file('z.md'), file('a.md')];

    sortFileEntries(entries, 'name');

    expect(entries.map((entry) => entry.name)).to.deep.equal(['z.md', 'a.md']);
  });
});
