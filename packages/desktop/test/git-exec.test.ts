import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitEnv, LOCAL_TIMEOUT_MS, runGit, withRepoLock } from '../main/git/exec.js';
import { detectGit } from '../main/git/detect.js';

/** realpath: on macOS os.tmpdir() is a symlink (/var → /private/var). */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'docblocks-git-'));
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: 'ignore',
  });
}

function initRepo(dir: string): void {
  git(dir, 'init');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

describe('desktop git exec', function () {
  let gitBin = '';
  let tmp = '';
  const savedConfigEnv: Record<string, string | undefined> = {};

  before(async function () {
    // Keep the user's global/system git config out of the picture.
    for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
      savedConfigEnv[key] = process.env[key];
      process.env[key] = os.devNull;
    }
    const tool = await detectGit();
    if (tool === null) this.skip();
    gitBin = tool.path;
  });

  after(() => {
    for (const [key, value] of Object.entries(savedConfigEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    tmp = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves with exit code 0 and captured stdout', async () => {
    const res = await runGit({ bin: gitBin, cwd: tmp, args: ['--version'] });

    expect(res.code).to.equal(0);
    expect(res.timedOut).to.equal(false);
    expect(res.stdout.toString('utf8')).to.match(/^git version \d/);
    expect(res.stderr).to.equal('');
  });

  it('resolves with a nonzero exit code and captured stderr in a non-repo', async () => {
    const res = await runGit({ bin: gitBin, cwd: tmp, args: ['rev-parse', '--show-toplevel'] });

    expect(res.code).to.be.a('number').and.not.equal(0);
    expect(res.timedOut).to.equal(false);
    expect(res.stderr).to.match(/not a git repository/i);
  });

  it('kills a blocked child after timeoutMs and reports timedOut', async function () {
    this.timeout(15_000);
    initRepo(tmp);
    // A pre-commit hook that sleeps blocks `git commit`. It redirects its
    // stdio to /dev/null first so the orphaned sleep cannot hold the pipes
    // open after git itself is killed.
    const hookPath = path.join(tmp, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/bin/sh\nexec >/dev/null 2>&1\nsleep 30\n', { mode: 0o755 });

    const started = Date.now();
    const res = await runGit({
      bin: gitBin,
      cwd: tmp,
      args: ['commit', '--allow-empty', '-m', 'blocked'],
      timeoutMs: 500,
    });

    expect(res.timedOut).to.equal(true);
    expect(res.code).to.equal(null);
    expect(Date.now() - started).to.be.lessThan(10_000);
  });

  it('aborts when stdout exceeds maxStdoutBytes', async () => {
    const res = await runGit({ bin: gitBin, cwd: tmp, args: ['help', '-a'], maxStdoutBytes: 64 });

    expect(res.stderr).to.contain('git output exceeded the size limit');
    expect(res.timedOut).to.equal(false);
    // The chunk that crossed the cap is dropped, so stdout stays small.
    expect(res.stdout.length).to.be.at.most(64);
  });

  it('exports a positive default local timeout', () => {
    expect(LOCAL_TIMEOUT_MS).to.be.a('number').and.greaterThan(0);
  });

  describe('withRepoLock', () => {
    it('serializes work queued under the same key', async () => {
      const order: string[] = [];
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const first = withRepoLock('exec-test-lock', async () => {
        order.push('first-start');
        await gate;
        order.push('first-end');
        return 1;
      });
      const second = withRepoLock('exec-test-lock', async () => {
        order.push('second');
        return 2;
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(order).to.deep.equal(['first-start']);

      release();
      expect(await first).to.equal(1);
      expect(await second).to.equal(2);
      expect(order).to.deep.equal(['first-start', 'first-end', 'second']);
    });

    it('does not block the queue when an earlier task rejects', async () => {
      const first = withRepoLock('exec-test-lock-reject', async () => {
        throw new Error('boom');
      });
      const second = withRepoLock('exec-test-lock-reject', async () => 'ran');

      let rejected: Error | null = null;
      try {
        await first;
      } catch (error) {
        rejected = error as Error;
      }
      expect(rejected).to.be.an('error');
      expect(rejected?.message).to.equal('boom');
      expect(await second).to.equal('ran');
    });
  });

  describe('gitEnv', () => {
    it('forbids prompts, pins the locale, and inherits process.env', () => {
      process.env.DOCBLOCKS_GIT_TEST_SENTINEL = 'sentinel-value';
      try {
        const env = gitEnv();
        expect(env.GIT_TERMINAL_PROMPT).to.equal('0');
        expect(env.LC_ALL).to.equal('C');
        expect(env.DOCBLOCKS_GIT_TEST_SENTINEL).to.equal('sentinel-value');
        expect(env.PATH).to.equal(process.env.PATH);
      } finally {
        delete process.env.DOCBLOCKS_GIT_TEST_SENTINEL;
      }
    });
  });
});
