import { expect } from 'chai';
import {
  LOCAL_AUTOSAVE_PACING,
  SYNCED_AUTOSAVE_PACING,
  autoSavePacingFor,
  isLikelySyncedLocation,
} from '../src/DocBlocksShell/synced-storage.js';

describe('synced storage pacing', () => {
  it('recognises the folders common sync clients use', () => {
    for (const location of [
      '/Users/mike/Library/Mobile Documents/iCloud~com~bendyline~docblocks/Documents',
      '/Users/mike/Library/Mobile Documents/com~apple~CloudDocs/Notes',
      '/Users/mike/Library/CloudStorage/OneDrive-Personal/Docs',
      'C:\\Users\\Mike\\OneDrive - Bendyline\\Documents\\DocBlocks',
      'C:\\Users\\Mike\\Dropbox\\Notes',
      '/Users/mike/Google Drive/My Drive/Notes',
      'iCloud Drive / DocBlocks',
    ]) {
      expect(isLikelySyncedLocation(location), location).to.equal(true);
    }
  });

  it('leaves ordinary folders and lookalikes alone', () => {
    for (const location of [
      '/Users/mike/DocBlocks',
      'C:\\Users\\Mike\\Documents\\DocBlocks',
      '/Users/mike/Projects/dropbox-clone/docs',
      '/Users/mike/Boxes/Notes',
      'On My iPhone / DocBlocks / Workspace',
      '',
      null,
      undefined,
    ]) {
      expect(isLikelySyncedLocation(location), String(location)).to.equal(false);
    }
  });

  it('saves more calmly on synced folders and on every phone or tablet folder', () => {
    expect(autoSavePacingFor({ location: '/Users/mike/DocBlocks', mobile: false })).to.equal(
      LOCAL_AUTOSAVE_PACING,
    );
    expect(autoSavePacingFor({ location: '/Users/mike/Dropbox/Notes', mobile: false })).to.equal(
      SYNCED_AUTOSAVE_PACING,
    );
    expect(
      autoSavePacingFor({ location: 'On My iPhone / DocBlocks / Workspace', mobile: true }),
    ).to.equal(SYNCED_AUTOSAVE_PACING);
    expect(SYNCED_AUTOSAVE_PACING.delayMs).to.be.greaterThan(LOCAL_AUTOSAVE_PACING.delayMs);
    expect(SYNCED_AUTOSAVE_PACING.maxWaitMs).to.be.greaterThan(SYNCED_AUTOSAVE_PACING.delayMs);
  });
});
