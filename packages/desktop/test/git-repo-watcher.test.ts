import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectRepo } from '../main/git/commands.js';
import type { RepoContext } from '../main/git/commands.js';
import { createRepoWatcher, type RepoWatcher } from '../main/git/repo-watcher.js';
import {
  createGitTestEnvironment,
  initializeFixtureRepository,
  runFixtureGit,
  type GitTestEnvironment,
} from './helpers/git-test-environment.js';

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

describe('desktop git repo watcher', function () {
  this.timeout(30_000);

  let gitBin = '';
  let gitTestEnvironment: GitTestEnvironment | null = null;
  let tmp = '';
  let ctx: RepoContext;
  let watcher: RepoWatcher | null = null;
  let changeCount = 0;

  before(async function () {
    gitTestEnvironment = await createGitTestEnvironment();
    if (gitTestEnvironment === null) this.skip();
    gitBin = gitTestEnvironment.bin;
  });

  after(() => {
    gitTestEnvironment?.dispose();
  });

  beforeEach(async () => {
    // realpath: on macOS os.tmpdir() is a symlink (/var → /private/var).
    tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'docblocks-git-'));
    initializeFixtureRepository(gitBin, tmp);
    fs.writeFileSync(path.join(tmp, 'seed.md'), 'seed\n');
    runFixtureGit(gitBin, tmp, 'add', '-A');
    runFixtureGit(gitBin, tmp, 'commit', '-m', 'seed');

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
    runFixtureGit(gitBin, tmp, 'add', '-A');
    runFixtureGit(gitBin, tmp, 'commit', '-m', 'next');

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

    runFixtureGit(gitBin, tmp, 'commit', '--allow-empty', '-m', 'after close');
    await delay(QUIET_WINDOW_MS);

    expect(changeCount, 'closed watcher must not notify').to.equal(0);
  });
});
