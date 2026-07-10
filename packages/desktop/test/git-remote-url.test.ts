/**
 * Tests for parse-remote-url — remote URL → web location mapping and
 * clone directory name derivation.
 */

import { expect } from 'chai';
import { parseRemoteUrl, deriveRepoDirName } from '../main/git/parse-remote-url.js';

describe('parseRemoteUrl', () => {
  it('parses https URLs with .git suffix', () => {
    expect(parseRemoteUrl('https://github.com/owner/repo.git')).to.deep.equal({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
      webUrl: 'https://github.com/owner/repo',
    });
  });

  it('parses https URLs without .git suffix', () => {
    expect(parseRemoteUrl('https://github.com/owner/repo')).to.deep.equal({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
      webUrl: 'https://github.com/owner/repo',
    });
  });

  it('strips trailing slashes and surrounding whitespace', () => {
    expect(parseRemoteUrl('  https://github.com/owner/repo/ \n')).to.deep.equal({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
      webUrl: 'https://github.com/owner/repo',
    });
  });

  it('parses http URLs and always emits an https web URL', () => {
    const parsed = parseRemoteUrl('http://git.internal/owner/repo.git');
    expect(parsed).to.deep.equal({
      host: 'git.internal',
      owner: 'owner',
      repo: 'repo',
      webUrl: 'https://git.internal/owner/repo',
    });
  });

  it('drops the port from https URLs in host and webUrl', () => {
    expect(parseRemoteUrl('https://git.example.com:8443/owner/repo.git')).to.deep.equal({
      host: 'git.example.com',
      owner: 'owner',
      repo: 'repo',
      webUrl: 'https://git.example.com/owner/repo',
    });
  });

  it('parses ssh:// URLs with a user', () => {
    expect(parseRemoteUrl('ssh://git@github.com/owner/repo.git')).to.deep.equal({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
      webUrl: 'https://github.com/owner/repo',
    });
  });

  it('parses ssh:// URLs without a user', () => {
    expect(parseRemoteUrl('ssh://github.com/owner/repo.git')).to.deep.equal({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
      webUrl: 'https://github.com/owner/repo',
    });
  });

  it('drops the ssh port from host and webUrl', () => {
    expect(parseRemoteUrl('ssh://git@github.com:2222/owner/repo.git')).to.deep.equal({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
      webUrl: 'https://github.com/owner/repo',
    });
  });

  it('parses scp-like URLs with a user', () => {
    expect(parseRemoteUrl('git@github.com:owner/repo.git')).to.deep.equal({
      host: 'github.com',
      owner: 'owner',
      repo: 'repo',
      webUrl: 'https://github.com/owner/repo',
    });
  });

  it('parses scp-like URLs without a user', () => {
    expect(parseRemoteUrl('git.example.com:owner/repo.git')).to.deep.equal({
      host: 'git.example.com',
      owner: 'owner',
      repo: 'repo',
      webUrl: 'https://git.example.com/owner/repo',
    });
  });

  it('handles GitLab subgroups over https', () => {
    expect(parseRemoteUrl('https://gitlab.com/group/sub/repo.git')).to.deep.equal({
      host: 'gitlab.com',
      owner: 'group/sub',
      repo: 'repo',
      webUrl: 'https://gitlab.com/group/sub/repo',
    });
  });

  it('handles GitLab subgroups in scp form', () => {
    expect(parseRemoteUrl('git@gitlab.com:group/sub/repo.git')).to.deep.equal({
      host: 'gitlab.com',
      owner: 'group/sub',
      repo: 'repo',
      webUrl: 'https://gitlab.com/group/sub/repo',
    });
  });

  it('returns null for file:// URLs', () => {
    expect(parseRemoteUrl('file:///path/to/repo.git')).to.equal(null);
  });

  it('returns null for absolute local paths', () => {
    expect(parseRemoteUrl('/local/path')).to.equal(null);
  });

  it('returns null for relative local paths', () => {
    expect(parseRemoteUrl('./relative/repo')).to.equal(null);
    expect(parseRemoteUrl('../up/repo')).to.equal(null);
  });

  it('returns null for host-less owner/repo strings', () => {
    expect(parseRemoteUrl('owner/repo')).to.equal(null);
  });

  it('returns null when there are fewer than two path segments', () => {
    expect(parseRemoteUrl('https://github.com/onlyone')).to.equal(null);
    expect(parseRemoteUrl('git@github.com:onlyone.git')).to.equal(null);
  });

  it('returns null for Windows drive paths', () => {
    expect(parseRemoteUrl('C:\\Users\\me\\repo')).to.equal(null);
    expect(parseRemoteUrl('C:/Users/me/repo')).to.equal(null);
  });

  it('returns null for a colon followed by a port-only path', () => {
    expect(parseRemoteUrl('example.com:8080')).to.equal(null);
  });

  it('returns null for empty input', () => {
    expect(parseRemoteUrl('')).to.equal(null);
    expect(parseRemoteUrl('   ')).to.equal(null);
  });
});

describe('deriveRepoDirName', () => {
  it('strips the .git suffix', () => {
    expect(deriveRepoDirName('https://github.com/owner/repo.git')).to.equal('repo');
  });

  it('ignores a trailing slash', () => {
    expect(deriveRepoDirName('https://github.com/owner/repo/')).to.equal('repo');
  });

  it('handles scp-like URLs', () => {
    expect(deriveRepoDirName('git@github.com:owner/repo.git')).to.equal('repo');
  });

  it('handles scp-like URLs without a slash in the path', () => {
    expect(deriveRepoDirName('git@github.com:repo.git')).to.equal('repo');
  });

  it('preserves uppercase and sanitizes disallowed characters', () => {
    expect(deriveRepoDirName('https://github.com/owner/My-Repo_2.0.git')).to.equal('My-Repo_2.0');
    expect(deriveRepoDirName('git@host.com:owner/my repo!.git')).to.equal('my-repo-');
  });

  it('falls back to "repository" for empty input', () => {
    expect(deriveRepoDirName('')).to.equal('repository');
    expect(deriveRepoDirName('   ')).to.equal('repository');
    expect(deriveRepoDirName('///')).to.equal('repository');
  });
});
