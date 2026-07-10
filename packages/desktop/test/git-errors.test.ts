/**
 * Tests for git error classification — realistic git stderr fixtures per
 * GitErrorCode, ordered-precedence cases, and makeGitError message /
 * truncation behavior.
 */

import { expect } from 'chai';
import { classifyGitError, makeGitError } from '../main/git/errors.js';

describe('classifyGitError', () => {
  it('classifies auth failures (https, credentials disabled)', () => {
    expect(
      classifyGitError(
        128,
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      ),
    ).to.equal('auth-failed');
  });

  it('classifies auth failures (ssh publickey)', () => {
    expect(
      classifyGitError(
        128,
        'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
      ),
    ).to.equal('auth-failed');
  });

  it('classifies remote-not-found', () => {
    expect(
      classifyGitError(
        128,
        "remote: Repository not found.\nfatal: repository 'https://github.com/x/y.git/' not found",
      ),
    ).to.equal('remote-not-found');
  });

  it('classifies network failures', () => {
    expect(
      classifyGitError(
        128,
        "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com",
      ),
    ).to.equal('network');
  });

  it('classifies non-fast-forward push rejections', () => {
    expect(
      classifyGitError(
        1,
        'To github.com:me/repo.git\n' +
          ' ! [rejected]        main -> main (non-fast-forward)\n' +
          "error: failed to push some refs to 'github.com:me/repo.git'\n" +
          'hint: Updates were rejected because the tip of your current branch is behind',
      ),
    ).to.equal('non-fast-forward');
  });

  it('classifies merge conflicts', () => {
    expect(
      classifyGitError(
        1,
        'Auto-merging notes.md\n' +
          'CONFLICT (content): Merge conflict in notes.md\n' +
          'Automatic merge failed; fix conflicts and then commit the result.',
      ),
    ).to.equal('merge-conflict');
  });

  it('classifies uncommitted-changes (checkout would overwrite)', () => {
    expect(
      classifyGitError(
        1,
        'error: Your local changes to the following files would be overwritten by merge:\n' +
          '\tnotes.md\n' +
          'Please commit your changes or stash them before you merge.',
      ),
    ).to.equal('uncommitted-changes');
  });

  it('classifies identity-not-configured', () => {
    expect(
      classifyGitError(
        128,
        '*** Please tell me who you are.\n\nRun\n\n' +
          '  git config --global user.email "you@example.com"\n' +
          '  git config --global user.name "Your Name"\n\n' +
          'fatal: unable to auto-detect email address',
      ),
    ).to.equal('identity-not-configured');
  });

  it('classifies no-upstream', () => {
    expect(
      classifyGitError(128, 'fatal: The current branch feat/x has no upstream branch.'),
    ).to.equal('no-upstream');
  });

  it('classifies unborn-branch', () => {
    expect(
      classifyGitError(128, "fatal: your current branch 'main' does not have any commits yet"),
    ).to.equal('unborn-branch');
  });

  it('classifies not-a-repository (local form)', () => {
    expect(
      classifyGitError(128, 'fatal: not a git repository (or any of the parent directories): .git'),
    ).to.equal('not-a-repository');
  });

  it('classifies branch-exists', () => {
    expect(classifyGitError(128, "fatal: a branch named 'feat' already exists")).to.equal(
      'branch-exists',
    );
  });

  it('classifies invalid-ref-name', () => {
    expect(classifyGitError(128, "fatal: 'foo..bar' is not a valid branch name")).to.equal(
      'invalid-ref-name',
    );
  });

  it('classifies detached-head', () => {
    expect(
      classifyGitError(0, "You are in 'detached HEAD' state. You can look around, make changes"),
    ).to.equal('detached-head');
  });

  it('classifies nothing-to-commit', () => {
    expect(classifyGitError(1, 'nothing to commit, working tree clean')).to.equal(
      'nothing-to-commit',
    );
  });

  it('returns unknown for unrecognized stderr', () => {
    expect(classifyGitError(128, 'fatal: some brand new inscrutable failure')).to.equal('unknown');
  });

  it('returns unknown for null exit code with empty stderr', () => {
    expect(classifyGitError(null, '')).to.equal('unknown');
  });

  describe('precedence (order is load-bearing)', () => {
    it("remote 'does not appear to be a git repository' hits remote-not-found, not not-a-repository", () => {
      expect(
        classifyGitError(
          128,
          "fatal: 'origin' does not appear to be a git repository\n" +
            'fatal: Could not read from remote repository.',
        ),
      ).to.equal('remote-not-found');
    });

    it('terminal-prompts-disabled username read is auth-failed', () => {
      expect(
        classifyGitError(
          128,
          'fatal: could not read Username for https://github.com: terminal prompts disabled',
        ),
      ).to.equal('auth-failed');
    });

    it("push rejection with both 'failed to push some refs' and 'non-fast-forward' is non-fast-forward", () => {
      expect(
        classifyGitError(
          1,
          ' ! [rejected]        main -> main (non-fast-forward)\n' +
            "error: failed to push some refs to 'https://github.com/me/repo.git'",
        ),
      ).to.equal('non-fast-forward');
    });
  });
});

describe('makeGitError', () => {
  it('uses the first meaningful stderr line, stripping the fatal: prefix', () => {
    const err = makeGitError(
      128,
      'fatal: not a git repository (or any of the parent directories): .git',
    );
    expect(err.code).to.equal('not-a-repository');
    expect(err.message).to.equal('not a git repository (or any of the parent directories): .git');
    expect(err.exitCode).to.equal(128);
    expect(err.stderr).to.equal(
      'fatal: not a git repository (or any of the parent directories): .git',
    );
  });

  it('skips blank and hint: lines when picking the message', () => {
    const err = makeGitError(
      1,
      '\nhint: Updates were rejected because the tip of your current branch is behind\n' +
        "error: failed to push some refs to 'https://github.com/me/repo.git'",
    );
    expect(err.code).to.equal('non-fast-forward');
    expect(err.message).to.equal("failed to push some refs to 'https://github.com/me/repo.git'");
  });

  it('falls back to fallbackMessage when stderr is empty', () => {
    const err = makeGitError(1, '', 'push failed');
    expect(err.code).to.equal('unknown');
    expect(err.message).to.equal('push failed');
    expect(err.stderr).to.equal(undefined);
    expect(err.exitCode).to.equal(1);
  });

  it('falls back to a generic message when stderr and fallback are both absent', () => {
    const err = makeGitError(null, '');
    expect(err.message).to.equal('git command failed');
    expect(err.exitCode).to.equal(undefined);
  });

  it('truncates stderr to 8 KB', () => {
    const big = 'fatal: boom\n' + 'x'.repeat(20000);
    const err = makeGitError(128, big);
    expect(err.stderr).to.have.length(8192);
    expect(err.message).to.equal('boom');
  });

  it('omits exitCode when the process was killed (null exit code)', () => {
    const err = makeGitError(null, 'fatal: boom');
    expect(err.exitCode).to.equal(undefined);
    expect(err.message).to.equal('boom');
  });
});
