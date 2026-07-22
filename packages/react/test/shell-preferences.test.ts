import { expect } from 'chai';
import {
  loadFileExplorerSortMode,
  saveFileExplorerSortMode,
} from '../src/DocBlocksShell/shell-preferences.js';

const SORT_MODE_KEY = 'docblocks:fileExplorerSortMode';

describe('shell preferences', () => {
  beforeEach(() => localStorage.removeItem(SORT_MODE_KEY));
  afterEach(() => localStorage.removeItem(SORT_MODE_KEY));

  it('defaults the file explorer to name sorting', () => {
    expect(loadFileExplorerSortMode()).to.equal('name');
  });

  it('round-trips the last selected file explorer sort mode', () => {
    saveFileExplorerSortMode('last-modified');
    expect(loadFileExplorerSortMode()).to.equal('last-modified');

    saveFileExplorerSortMode('name');
    expect(loadFileExplorerSortMode()).to.equal('name');
  });

  it('falls back to name sorting for an unrecognized persisted value', () => {
    localStorage.setItem(SORT_MODE_KEY, 'newest-ish');
    expect(loadFileExplorerSortMode()).to.equal('name');
  });
});
