import { expect } from 'chai';
import { parseWorkspacePath, type FileSystemEntry } from '@bendyline/docblocks/filesystem';
import type { WorkspaceIndex, WorkspaceIndexFile } from '@bendyline/docblocks/workspace-index';
import {
  folderLooksEmpty,
  indexFolderContents,
  listedFolderContents,
} from '../src/FileExplorer/folder-contents.js';

type IndexView = Pick<WorkspaceIndex, 'getFiles' | 'getDirectories' | 'has'>;

function file(path: string): WorkspaceIndexFile {
  return {
    path: parseWorkspacePath(path),
    name: path.slice(path.lastIndexOf('/') + 1),
    size: 1,
    lastModified: '2026-11-25T00:00:00.000Z',
    kind: 'markdown',
  };
}

/**
 * An index that has listed `files` and `directories` in full, except beneath
 * `unreadable`. `has` follows the real index: present for what it holds,
 * unknown beneath an unreadable folder, absent otherwise.
 */
function fakeIndex(
  files: readonly string[],
  directories: readonly string[],
  unreadable: readonly string[] = [],
): IndexView {
  const all = new Set([...files, ...directories]);
  return {
    getFiles: () => files.map(file),
    getDirectories: () => directories.map((path) => parseWorkspacePath(path)),
    has: (path) => {
      if (all.has(path)) return 'present';
      if (unreadable.some((folder) => path.startsWith(`${folder}/`))) return 'unknown';
      return 'absent';
    },
  };
}

describe('folder contents', () => {
  it('calls a folder empty only when a source knows it and none has seen anything', () => {
    expect(folderLooksEmpty('none', 'unknown')).to.equal(true);
    expect(folderLooksEmpty('unknown', 'none')).to.equal(true);
    expect(folderLooksEmpty('none', 'none')).to.equal(true);
    // Either source can lag the other: whichever has seen contents wins.
    expect(folderLooksEmpty('none', 'some')).to.equal(false);
    expect(folderLooksEmpty('some', 'none')).to.equal(false);
    expect(folderLooksEmpty('unknown', 'unknown')).to.equal(false);
    expect(folderLooksEmpty()).to.equal(false);
  });

  it("reads the tree's own listing once it has one", () => {
    const entry: FileSystemEntry = { kind: 'file', name: 'a.md', path: 'Notes/a.md' };
    expect(listedFolderContents(undefined)).to.equal('unknown');
    expect(listedFolderContents([])).to.equal('none');
    expect(listedFolderContents([entry])).to.equal('some');
  });

  it('finds empty folders in what the index has listed', () => {
    const contents = indexFolderContents(
      fakeIndex(
        ['Notes/a.md', 'Projects/Plans/q1.md'],
        ['Notes', 'Projects', 'Projects/Plans', 'Empty', 'Tasks', 'Tasks/Done'],
      ),
    );
    expect(contents('Notes')).to.equal('some');
    // A folder holding only folders still has something to open onto.
    expect(contents('Projects')).to.equal('some');
    expect(contents('/Empty')).to.equal('none');
    expect(contents('Tasks')).to.equal('some');
    expect(contents('Tasks/Done')).to.equal('none');
  });

  it('does not count what the tree leaves out', () => {
    const contents = indexFolderContents(
      fakeIndex(
        ['Inbox/.DS_Store', 'Site/catalog.html', 'Media/photo.png'],
        ['Inbox', 'Site', 'Media', 'Media/photo.png_files'],
      ),
      ['site/CATALOG.html'],
    );
    expect(contents('Inbox')).to.equal('none');
    expect(contents('Site')).to.equal('none');
    expect(contents('Media')).to.equal('some');
    expect(contents('Media/photo.png_files')).to.equal('none');
  });

  it('says it does not know when the index cannot vouch for a folder', () => {
    const contents = indexFolderContents(
      fakeIndex(['Shared/b.md'], ['Locked', 'Shared'], ['Locked']),
    );
    // Listed, but its contents could not be read.
    expect(contents('Locked')).to.equal('unknown');
    // Not in the index yet: made since its last look.
    expect(contents('Brand new')).to.equal('unknown');
    // The workspace root is the tree itself, never a row.
    expect(contents('')).to.equal('unknown');
    expect(contents('Shared')).to.equal('some');
  });

  it('says it does not know before the index has listed the workspace', () => {
    const unlisted: IndexView = {
      ...fakeIndex([], ['Notes']),
      has: (path) => (path === 'Notes' ? 'present' : 'unknown'),
    };
    expect(indexFolderContents(unlisted)('Notes')).to.equal('unknown');
  });
});
