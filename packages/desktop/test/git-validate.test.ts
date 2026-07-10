/**
 * Tests for git input validation — branch names (mirrors git
 * check-ref-format --branch), SHAs, remote names, and clone URLs.
 */

import { expect } from 'chai';
import {
  isValidBranchName,
  isValidCloneUrl,
  isValidRemoteName,
  isValidSha,
} from '../main/git/validate.js';

describe('isValidBranchName', () => {
  const valid = ['main', 'feat/x-1', 'release/2026.07', 'a_b', 'v1.2.3-rc.1'];
  for (const name of valid) {
    it(`accepts '${name}'`, () => {
      expect(isValidBranchName(name)).to.equal(true);
    });
  }

  const invalid = [
    '-x',
    '.x',
    'a..b',
    'a@{b',
    '@',
    'a b',
    'a~b',
    'a^b',
    'a:b',
    'a?b',
    'a*b',
    'a[b',
    'a\\b',
    'a/',
    '/a',
    'a//b',
    'a.',
    'a.lock',
    'x/y.lock',
    'a\x01b',
    'a\x7fb',
    '',
  ];
  for (const name of invalid) {
    it(`rejects ${JSON.stringify(name)}`, () => {
      expect(isValidBranchName(name)).to.equal(false);
    });
  }
});

describe('isValidSha', () => {
  it('accepts abbreviated and full SHAs', () => {
    expect(isValidSha('abcd')).to.equal(true);
    expect(isValidSha('ABCDEF1234')).to.equal(true);
    expect(isValidSha('0123456789abcdef0123456789abcdef01234567')).to.equal(true);
  });

  it('rejects too-short, too-long, non-hex, and empty input', () => {
    expect(isValidSha('abc')).to.equal(false);
    expect(isValidSha('0123456789abcdef0123456789abcdef012345678')).to.equal(false);
    expect(isValidSha('xyz1')).to.equal(false);
    expect(isValidSha('abcd ')).to.equal(false);
    expect(isValidSha('')).to.equal(false);
  });
});

describe('isValidRemoteName', () => {
  it('accepts common remote names', () => {
    expect(isValidRemoteName('origin')).to.equal(true);
    expect(isValidRemoteName('upstream-2')).to.equal(true);
    expect(isValidRemoteName('r2.d_2')).to.equal(true);
  });

  it('rejects bad first chars, spaces, and empty input', () => {
    expect(isValidRemoteName('')).to.equal(false);
    expect(isValidRemoteName('-origin')).to.equal(false);
    expect(isValidRemoteName('.origin')).to.equal(false);
    expect(isValidRemoteName('ori gin')).to.equal(false);
    expect(isValidRemoteName('origin!')).to.equal(false);
  });
});

describe('isValidCloneUrl', () => {
  const valid = [
    'https://github.com/a/b.git',
    'http://example.com/a',
    'ssh://git@github.com/a/b.git',
    'git://example.com/a/b',
    'git@github.com:a/b.git',
  ];
  for (const url of valid) {
    it(`accepts '${url}'`, () => {
      expect(isValidCloneUrl(url)).to.equal(true);
    });
  }

  const invalid = [
    '',
    '-https://github.com/a/b.git',
    '-user@host:path',
    'file:///tmp/x',
    '/tmp/x',
    'C:\\repos\\x',
    '../x',
    './x',
    'https://exa mple.com/x',
    'https://example.com/a\n',
    'https://example.com/a\x01b',
  ];
  for (const url of invalid) {
    it(`rejects ${JSON.stringify(url)}`, () => {
      expect(isValidCloneUrl(url)).to.equal(false);
    });
  }

  describe('allowLocal escape hatch (tests only)', () => {
    const locals = ['file:///tmp/x', '/tmp/x', 'C:\\repos\\x', '../x'];
    for (const url of locals) {
      it(`accepts ${JSON.stringify(url)} with allowLocal`, () => {
        expect(isValidCloneUrl(url, { allowLocal: true })).to.equal(true);
      });
    }

    it('still rejects leading dash and whitespace with allowLocal', () => {
      expect(isValidCloneUrl('-x', { allowLocal: true })).to.equal(false);
      expect(isValidCloneUrl('/tmp/a b', { allowLocal: true })).to.equal(false);
    });
  });
});
