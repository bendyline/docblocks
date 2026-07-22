import { expect } from 'chai';
import type { FileSystemEntry } from '@bendyline/docblocks/filesystem';
import {
  filterVisibleFileEntries,
  isHiddenFileEntry,
} from '../src/FileExplorer/entry-visibility.js';

function entry(path: string, kind: FileSystemEntry['kind'] = 'directory'): FileSystemEntry {
  return { kind, name: path.split('/').pop() ?? path, path };
}

describe('file entry visibility', () => {
  it('hides document sidecar directories in nested folder listings', () => {
    const entries = [
      entry('/guides/topic_files'),
      entry('/guides/topic.md', 'file'),
      entry('/guides/examples'),
    ];

    expect(filterVisibleFileEntries(entries).map(({ path }) => path)).to.deep.equal([
      '/guides/topic.md',
      '/guides/examples',
    ]);
  });

  it('does not hide files whose names happen to end in _files', () => {
    expect(isHiddenFileEntry(entry('/guides/topic_files', 'file'))).to.equal(false);
  });

  it('continues to hide dot entries from user-facing file lists', () => {
    expect(isHiddenFileEntry(entry('/guides/.versions'))).to.equal(true);
  });
});
