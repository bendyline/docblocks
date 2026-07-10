/**
 * Tests for git-clone-utils — folder-name derivation must mirror the
 * host's rule for every URL shape, and the URL shape check gates the
 * Clone button (loose accept, hard reject of file:/dash-leading forms).
 */
import { expect } from 'chai';
import { deriveCloneFolderName, isLikelyGitUrl } from '../src/Git/git-clone-utils.js';

describe('git-clone-utils', () => {
  describe('deriveCloneFolderName', () => {
    it('strips .git from https URLs', () => {
      expect(deriveCloneFolderName('https://github.com/owner/repo.git')).to.equal('repo');
    });

    it('handles https URLs without .git', () => {
      expect(deriveCloneFolderName('https://github.com/owner/repo')).to.equal('repo');
    });

    it('ignores trailing slashes', () => {
      expect(deriveCloneFolderName('https://github.com/owner/repo/')).to.equal('repo');
      expect(deriveCloneFolderName('https://github.com/owner/repo.git///')).to.equal('repo');
    });

    it('handles scp-style URLs', () => {
      expect(deriveCloneFolderName('git@github.com:owner/repo.git')).to.equal('repo');
    });

    it('strips .git case-insensitively', () => {
      expect(deriveCloneFolderName('https://github.com/owner/repo.GIT')).to.equal('repo');
    });

    it('sanitizes characters that are unsafe in folder names', () => {
      expect(deriveCloneFolderName('https://example.com/owner/my repo!.git')).to.equal('my-repo-');
      expect(deriveCloneFolderName('https://example.com/owner/dots.and_dashes-ok.git')).to.equal(
        'dots.and_dashes-ok',
      );
    });

    it('falls back to "repository" when nothing usable remains', () => {
      expect(deriveCloneFolderName('')).to.equal('repository');
      expect(deriveCloneFolderName('   ')).to.equal('repository');
      expect(deriveCloneFolderName('///')).to.equal('repository');
    });
  });

  describe('isLikelyGitUrl', () => {
    it('accepts https / http / ssh / git protocol URLs', () => {
      expect(isLikelyGitUrl('https://github.com/owner/repo.git')).to.equal(true);
      expect(isLikelyGitUrl('http://internal.example/owner/repo')).to.equal(true);
      expect(isLikelyGitUrl('ssh://git@github.com/owner/repo.git')).to.equal(true);
      expect(isLikelyGitUrl('git://example.com/owner/repo')).to.equal(true);
    });

    it('accepts scp-style URLs', () => {
      expect(isLikelyGitUrl('git@github.com:owner/repo.git')).to.equal(true);
      expect(isLikelyGitUrl('deploy.bot@git.example.co:group/project')).to.equal(true);
    });

    it('tolerates surrounding whitespace', () => {
      expect(isLikelyGitUrl('  https://github.com/owner/repo.git  ')).to.equal(true);
    });

    it('rejects file: URLs', () => {
      expect(isLikelyGitUrl('file:///Users/me/repo')).to.equal(false);
      expect(isLikelyGitUrl('FILE:///Users/me/repo')).to.equal(false);
    });

    it('rejects dash-leading strings (argument injection)', () => {
      expect(isLikelyGitUrl('--upload-pack=evil')).to.equal(false);
      expect(isLikelyGitUrl('-o')).to.equal(false);
    });

    it('rejects strings with interior whitespace', () => {
      expect(isLikelyGitUrl('https://github.com/owner /repo')).to.equal(false);
      expect(isLikelyGitUrl('git@github.com: owner/repo')).to.equal(false);
    });

    it('rejects empty strings and plain words', () => {
      expect(isLikelyGitUrl('')).to.equal(false);
      expect(isLikelyGitUrl('   ')).to.equal(false);
      expect(isLikelyGitUrl('hello')).to.equal(false);
      expect(isLikelyGitUrl('owner/repo')).to.equal(false);
    });

    it('rejects protocol URLs without an owner/repo path', () => {
      expect(isLikelyGitUrl('https://github.com')).to.equal(false);
    });
  });
});
