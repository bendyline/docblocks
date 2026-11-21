import { expect } from 'chai';
import { friendlyWorkspaceLocation } from '../src/workspace-location.js';

describe('friendlyWorkspaceLocation', () => {
  it('names the DocBlocks folder in iCloud Drive the way Finder does', () => {
    expect(
      friendlyWorkspaceLocation(
        '/Users/mike/Library/Mobile Documents/iCloud~com~bendyline~docblocks/Documents',
      ),
    ).to.equal('iCloud Drive/DocBlocks');
    expect(
      friendlyWorkspaceLocation(
        '/Users/mike/Library/Mobile Documents/iCloud~com~bendyline~docblocks/Documents/Notes/2026/',
      ),
    ).to.equal('iCloud Drive/DocBlocks/Notes/2026');
  });

  it('names iCloud Drive itself and keeps the folders inside it', () => {
    expect(
      friendlyWorkspaceLocation('/Users/mike/Library/Mobile Documents/com~apple~CloudDocs'),
    ).to.equal('iCloud Drive');
    expect(
      friendlyWorkspaceLocation(
        '/Users/mike/Library/Mobile Documents/com~apple~CloudDocs/Writing/Mobile Documents',
      ),
    ).to.equal('iCloud Drive/Writing/Mobile Documents');
  });

  it("names other apps' folders from their container id", () => {
    expect(
      friendlyWorkspaceLocation(
        '/Users/mike/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault',
      ),
    ).to.equal('iCloud Drive/Obsidian/Vault');
    expect(
      friendlyWorkspaceLocation('/Users/mike/Library/Mobile Documents/com~apple~Pages/Documents'),
    ).to.equal('iCloud Drive/Pages');
  });

  it('recognises the iOS layout of the same folders', () => {
    expect(
      friendlyWorkspaceLocation(
        '/private/var/mobile/Library/Mobile Documents/iCloud~com~bendyline~docblocks/Documents',
      ),
    ).to.equal('iCloud Drive/DocBlocks');
  });

  it("leaves the hidden parts of an app's container as they are", () => {
    for (const location of [
      '/Users/mike/Library/Mobile Documents/iCloud~com~bendyline~docblocks',
      '/Users/mike/Library/Mobile Documents/iCloud~com~bendyline~docblocks/Data',
      '/Users/mike/Library/Mobile Documents',
    ]) {
      expect(friendlyWorkspaceLocation(location), location).to.equal(location);
    }
  });

  it('names iCloud Drive on Windows', () => {
    expect(friendlyWorkspaceLocation('C:\\Users\\Mike\\iCloudDrive')).to.equal('iCloud Drive');
    expect(friendlyWorkspaceLocation('C:\\Users\\Mike\\iCloudDrive\\Writing\\Drafts')).to.equal(
      'iCloud Drive\\Writing\\Drafts',
    );
    expect(
      friendlyWorkspaceLocation(
        'C:\\Users\\Mike\\iCloudDrive\\iCloud~com~bendyline~docblocks\\Notes',
      ),
    ).to.equal('iCloud Drive\\DocBlocks\\Notes');
  });

  it('leaves every other location unchanged', () => {
    for (const location of [
      '/Users/mike/gh/bendyline.github.io/posts',
      '/Users/mike/Documents/Library/Mobile Documents copy',
      'C:\\Users\\Mike\\Documents\\DocBlocks',
      'D:\\Archive\\iCloudDrive\\Notes',
      '',
    ]) {
      expect(friendlyWorkspaceLocation(location), location).to.equal(location);
    }
  });
});
