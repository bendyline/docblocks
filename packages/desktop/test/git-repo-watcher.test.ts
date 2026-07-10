import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectGit } from '../main/git/detect.js';
import { detectRepo } from '../main/git/commands.js';
import type { RepoContext } from '../main/git/commands.js';
import { createRepoWatcher, type RepoWatcher } from '../main/git/repo-watcher.js';

/** Time chokidar gets to finish its initial scan before we mutate the repo. */
const WATCHER_WARMUP_MS = 1_000;
/** Window in which an expected change must be observed. */
const CHANGE_WINDOW_MS = 10_000;
/** Window we hold open to prove NO change fires. */
const QUIET_WINDOW_MS = 1_500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(100);
  }
  return predicate();
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: 'ignore',
  });
}

describe('desktop git repo watcher', function () {
  this.timeout(30_000);

  let gitBin = '';
  let tmp = '';
  let ctx: RepoContext;
  let watcher: RepoWatcher | null = null;
  let changeCount = 0;
  const savedConfigEnv: Record<string, string | undefined> = {};

  before(async function () {
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

  beforeEach(async () => {
    // realpath: on macOS os.tmpdir() is a symlink (/var → /private/var).
    tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'docblocks-git-'));
    git(tmp, 'init');
    git(tmp, 'config', 'user.email', 't@example.com');
    git(tmp, 'config', 'user.name', 'Test');
    git(tmp, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(tmp, 'seed.md'), 'seed\n');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'seed');

    const { context } = await detectRepo(gitBin, tmp);
    if (context === null) throw new Error('fixture repository was not detected');
    ctx = context;

    changeCount = 0;
    watcher = createRepoWatcher({
      gitDir: ctx.gitDir,
      commonDir: ctx.commonDir,
      onChange: () => {
        changeCount += 1;
      },
    });
    await delay(WATCHER_WARMUP_MS);
  });

  afterEach(async () => {
    if (watcher !== null) {
      await watcher.close();
      watcher = null;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fires onChange when a commit updates repository state', async () => {
    fs.writeFileSync(path.join(tmp, 'next.md'), 'next\n');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'next');

    const fired = await waitFor(() => changeCount > 0, CHANGE_WINDOW_MS);
    expect(fired, 'expected onChange after a commit').to.equal(true);
  });

  it('ignores transient index.lock churn', async () => {
    const lockPath = path.join(ctx.gitDir, 'index.lock');
    fs.writeFileSync(lockPath, '');
    await delay(500);
    fs.rmSync(lockPath, { force: true });
    await delay(QUIET_WINDOW_MS);

    expect(changeCount, 'lock-file churn must not notify').to.equal(0);
  });

  it('stops firing after close() resolves', async () => {
    await (watcher as RepoWatcher).close();
    watcher = null;

    git(tmp, 'commit', '--allow-empty', '-m', 'after close');
    await delay(QUIET_WINDOW_MS);

    expect(changeCount, 'closed watcher must not notify').to.equal(0);
  });
});
