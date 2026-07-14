import { expect } from 'chai';
import path from 'node:path';
import { suggestedDefaultRoot } from '../main/icloud-detect.js';

describe('suggestedDefaultRoot', () => {
  it('uses the OS-resolved Documents folder, including redirected locations', () => {
    const documentsPath = path.join('redirected-user', 'OneDrive', 'Documents');

    expect(suggestedDefaultRoot(documentsPath)).to.equal(path.join(documentsPath, 'DocBlocks'));
  });
});
