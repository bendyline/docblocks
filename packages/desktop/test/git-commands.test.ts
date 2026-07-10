import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { GitError, GitResult } from '@bendyline/docblocks/host';
import { detectGit } from '../main/git/detect.js';
import * as commands from '../main/git/commands.js';
import type { RepoContext } from '../main/git/commands.js';

const SHA_RE = /^[0-9a-f]{40}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

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

function write(dir: string, rel: string, content: string | Buffer): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function unwrap<T>(result: GitResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok result, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

function unwrapError<T>(result: GitResult<T>): GitError {
  if (result.ok) throw new Error('expected the git operation to fail');
  return result.error;
}

describe('desktop git commands', function () {
  this.timeout(30_000);

  let gitBin = '';
  let tmpBase = '';
  const savedConfigEnv: Record<string, string | undefined> = {};

  interface Fixture {
    dir: string;
    ctx: RepoContext;
  }

  async function makeRepo(): Promise<Fixture> {
    const dir = fs.mkdtempSync(path.join(tmpBase, 'repo-'));
    initRepo(dir);
    const { context } = await commands.detectRepo(gitBin, dir);
    if (context === null) throw new Error('fixture repository was not detected');
    return { dir, ctx: context };
  }

  before(async function () {
    // Keep the user's global/system git config out of the picture so branch
    // names, hooks, and signing settings are what the fixtures set up.
    for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
      savedConfigEnv[key] = process.env[key];
      process.env[key] = os.devNull;
    }
    const tool = await detectGit();
    if (tool === null) this.skip();
    gitBin = tool.path;
    // realpath: on macOS os.tmpdir() is a symlink (/var → /private/var).
    tmpBase = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'docblocks-git-'));
  });

  after(() => {
    for (const [key, value] of Object.entries(savedConfigEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (tmpBase !== '') fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  describe('repository detection and init', () => {
    it('reports a plain directory as not a repository', async () => {
      const dir = fs.mkdtempSync(path.join(tmpBase, 'plain-'));
      const { detection, context } = await commands.detectRepo(gitBin, dir);

      expect(detection).to.deep.equal({ isRepo: false });
      expect(context).to.equal(null);
    });

    it('detects a repository created via init', async () => {
      const dir = fs.mkdtempSync(path.join(tmpBase, 'init-'));
      unwrap(await commands.init(gitBin, dir));

      const { detection, context } = await commands.detectRepo(gitBin, dir);
      expect(detection.isRepo).to.equal(true);
      expect(detection.rootIsToplevel).to.equal(true);
      expect(detection.toplevel).to.equal(dir);
      expect(context).to.not.equal(null);
      expect(context?.workspaceRoot).to.equal(dir);
      expect(context?.toplevel).to.equal(dir);
      expect(context?.gitDir).to.equal(path.join(dir, '.git'));
      expect(context?.commonDir).to.equal(path.join(dir, '.git'));
    });

    it('treats a subdirectory workspace as non-toplevel and remaps status paths', async () => {
      const repo = await makeRepo();
      const sub = path.join(repo.dir, 'docs');
      write(repo.dir, 'docs/inner.md', 'inner\n');
      write(repo.dir, 'outer.md', 'outer\n');

      const { detection, context } = await commands.detectRepo(gitBin, sub);
      expect(detection.isRepo).to.equal(true);
      expect(detection.rootIsToplevel).to.equal(false);
      expect(detection.toplevel).to.equal(repo.dir);
      expect(context?.workspaceRoot).to.equal(sub);

      // Paths come back relative to the subdirectory workspace, and changes
      // outside the workspace are excluded.
      const status = unwrap(await commands.status(context as RepoContext));
      expect(status.changes).to.deep.equal([
        {
          path: '/inner.md',
          origPath: undefined,
          index: undefined,
          worktree: 'untracked',
          conflicted: false,
        },
      ]);
    });
  });

  describe('status and the commit lifecycle', () => {
    let repo: Fixture;

    before(async () => {
      repo = await makeRepo();
    });

    it('reports a fresh repository as unborn with no changes', async () => {
      const status = unwrap(await commands.status(repo.ctx));

      expect(status.unborn).to.equal(true);
      expect(status.head).to.equal(null);
      expect(status.detached).to.equal(false);
      expect(status.branch).to.be.a('string').and.not.equal('');
      expect(status.changes).to.deep.equal([]);
      expect(status.operation).to.equal(null);
    });

    it('reports a new file as untracked', async () => {
      write(repo.dir, 'hello.md', 'hello v1\n');

      const status = unwrap(await commands.status(repo.ctx));
      expect(status.changes).to.deep.equal([
        {
          path: '/hello.md',
          origPath: undefined,
          index: undefined,
          worktree: 'untracked',
          conflicted: false,
        },
      ]);
    });

    it('commits selected paths and returns the new commit sha', async () => {
      const { sha } = unwrap(await commands.commit(repo.ctx, 'first commit', ['/hello.md']));
      expect(sha).to.match(SHA_RE);

      const status = unwrap(await commands.status(repo.ctx));
      expect(status.unborn).to.equal(false);
      expect(status.head).to.equal(sha);
      expect(status.changes).to.deep.equal([]);
    });

    it('rejects an empty commit message without spawning git', async () => {
      const error = unwrapError(await commands.commit(repo.ctx, '   '));
      expect(error.code).to.equal('unknown');
      expect(error.message).to.equal('Commit message is empty');
    });

    it('classifies committing with no changes as nothing-to-commit', async () => {
      const error = unwrapError(await commands.commit(repo.ctx, 'nothing staged'));
      expect(error.code).to.equal('nothing-to-commit');
    });

    it('stages and unstages a modification', async () => {
      write(repo.dir, 'hello.md', 'hello v2\n');

      unwrap(await commands.stage(repo.ctx, ['/hello.md']));
      let status = unwrap(await commands.status(repo.ctx));
      expect(status.changes).to.have.length(1);
      expect(status.changes[0].path).to.equal('/hello.md');
      expect(status.changes[0].index).to.equal('modified');
      expect(status.changes[0].worktree).to.equal(undefined);

      unwrap(await commands.unstage(repo.ctx, ['/hello.md']));
      status = unwrap(await commands.status(repo.ctx));
      expect(status.changes).to.have.length(1);
      expect(status.changes[0].index).to.equal(undefined);
      expect(status.changes[0].worktree).to.equal('modified');
    });

    it('discards tracked modifications and deletes untracked files', async () => {
      // hello.md is still modified from the previous test.
      write(repo.dir, 'junk.md', 'scratch\n');

      unwrap(await commands.discard(repo.ctx, ['/hello.md', '/junk.md']));

      expect(fs.readFileSync(path.join(repo.dir, 'hello.md'), 'utf8')).to.equal('hello v1\n');
      expect(fs.existsSync(path.join(repo.dir, 'junk.md'))).to.equal(false);
      const status = unwrap(await commands.status(repo.ctx));
      expect(status.changes).to.deep.equal([]);
    });
  });

  describe('branch operations', () => {
    let repo: Fixture;
    let defaultBranch = '';
    let baseSha = '';

    before(async () => {
      repo = await makeRepo();
      write(repo.dir, 'base.md', 'base\n');
      baseSha = unwrap(await commands.commit(repo.ctx, 'base commit', ['/base.md'])).sha;
      const status = unwrap(await commands.status(repo.ctx));
      defaultBranch = status.branch as string;
    });

    it('creates and checks out a new branch by default', async () => {
      unwrap(await commands.createBranch(repo.ctx, 'feature'));

      const status = unwrap(await commands.status(repo.ctx));
      expect(status.branch).to.equal('feature');

      const branches = unwrap(await commands.listBranches(repo.ctx));
      const feature = branches.find((b) => b.name === 'feature');
      const main = branches.find((b) => b.name === defaultBranch);
      expect(feature?.kind).to.equal('local');
      expect(feature?.current).to.equal(true);
      expect(feature?.headSha).to.equal(baseSha);
      expect(main?.current).to.equal(false);
    });

    it('checks out an existing branch', async () => {
      unwrap(await commands.checkoutBranch(repo.ctx, defaultBranch));

      const status = unwrap(await commands.status(repo.ctx));
      expect(status.branch).to.equal(defaultBranch);
    });

    it('rejects an invalid branch name without spawning git', async () => {
      const error = unwrapError(await commands.createBranch(repo.ctx, 'a..b'));
      expect(error.code).to.equal('invalid-ref-name');
    });

    it('reports a duplicate branch as branch-exists', async () => {
      const error = unwrapError(await commands.createBranch(repo.ctx, 'feature'));
      expect(error.code).to.equal('branch-exists');
      expect(error.stderr).to.match(/already exists/i);
    });

    it('reports a detached HEAD', async () => {
      git(repo.dir, 'checkout', '--detach', baseSha);
      try {
        const status = unwrap(await commands.status(repo.ctx));
        expect(status.detached).to.equal(true);
        expect(status.branch).to.equal(null);
        expect(status.head).to.equal(baseSha);
      } finally {
        git(repo.dir, 'checkout', defaultBranch);
      }
    });
  });

  describe('history', () => {
    let repo: Fixture;
    let sha1 = '';
    let sha2 = '';
    let sha3 = '';

    before(async () => {
      repo = await makeRepo();
      write(repo.dir, 'f1.md', 'v1\n');
      sha1 = unwrap(await commands.commit(repo.ctx, 'first', ['/f1.md'])).sha;
      write(repo.dir, 'f1.md', 'v2\n');
      sha2 = unwrap(await commands.commit(repo.ctx, 'second', ['/f1.md'])).sha;
      git(repo.dir, 'mv', 'f1.md', 'f2.md');
      sha3 = unwrap(await commands.commit(repo.ctx, 'rename f1 to f2')).sha;
    });

    it('lists commits newest-first with parents, subjects, and ISO dates', async () => {
      const entries = unwrap(await commands.log(repo.ctx));

      expect(entries.map((e) => e.sha)).to.deep.equal([sha3, sha2, sha1]);
      expect(entries.map((e) => e.subject)).to.deep.equal(['rename f1 to f2', 'second', 'first']);
      expect(entries[0].parents).to.deep.equal([sha2]);
      expect(entries[2].parents).to.deep.equal([]);
      for (const entry of entries) {
        expect(entry.authorName).to.equal('Test');
        expect(entry.authorEmail).to.equal('t@example.com');
        expect(entry.authorDate).to.match(ISO_DATE_RE);
      }
    });

    it('follows renames for per-file history', async () => {
      const entries = unwrap(await commands.log(repo.ctx, { path: '/f2.md' }));
      expect(entries.map((e) => e.sha)).to.deep.equal([sha3, sha2, sha1]);
    });

    it('returns an empty log for an unborn repository', async () => {
      const unborn = await makeRepo();
      expect(unwrap(await commands.log(unborn.ctx))).to.deep.equal([]);
    });

    it('returns the message body and file statuses for a commit', async () => {
      const rename = unwrap(await commands.commitFiles(repo.ctx, sha3));
      expect(rename.body).to.equal('rename f1 to f2');
      expect(rename.files).to.deep.equal([
        { path: '/f2.md', origPath: '/f1.md', index: 'renamed', conflicted: false },
      ]);

      const initial = unwrap(await commands.commitFiles(repo.ctx, sha1));
      expect(initial.files).to.deep.equal([
        { path: '/f1.md', origPath: undefined, index: 'added', conflicted: false },
      ]);
    });
  });

  describe('readFileAtRevision', () => {
    let repo: Fixture;
    let sha1 = '';
    let sha2 = '';

    before(async () => {
      repo = await makeRepo();
      write(repo.dir, 'note.md', 'v1\n');
      sha1 = unwrap(await commands.commit(repo.ctx, 'first', ['/note.md'])).sha;
      write(repo.dir, 'note.md', 'v2\n');
      sha2 = unwrap(await commands.commit(repo.ctx, 'second', ['/note.md'])).sha;
      write(repo.dir, 'bin.dat', Buffer.from([0x89, 0x50, 0x00, 0x01, 0x00, 0xff]));
      unwrap(await commands.commit(repo.ctx, 'binary', ['/bin.dat']));
    });

    it('reads the file at HEAD', async () => {
      const file = unwrap(
        await commands.readFileAtRevision(repo.ctx, '/note.md', { kind: 'head' }),
      );
      expect(file).to.deep.equal({ content: 'v2\n', binary: false });
    });

    it('reads the file at a specific commit', async () => {
      const file = unwrap(
        await commands.readFileAtRevision(repo.ctx, '/note.md', { kind: 'commit', sha: sha1 }),
      );
      expect(file).to.deep.equal({ content: 'v1\n', binary: false });
    });

    it('reads the file at the parent of a commit', async () => {
      const file = unwrap(
        await commands.readFileAtRevision(repo.ctx, '/note.md', { kind: 'parent-of', sha: sha2 }),
      );
      expect(file).to.deep.equal({ content: 'v1\n', binary: false });
    });

    it('returns null content for the parent of the root commit', async () => {
      const file = unwrap(
        await commands.readFileAtRevision(repo.ctx, '/note.md', { kind: 'parent-of', sha: sha1 }),
      );
      expect(file).to.deep.equal({ content: null, binary: false });
    });

    it('returns null content for a path missing at the revision', async () => {
      const file = unwrap(
        await commands.readFileAtRevision(repo.ctx, '/missing.md', { kind: 'head' }),
      );
      expect(file).to.deep.equal({ content: null, binary: false });
    });

    it('flags binary content instead of returning it', async () => {
      const file = unwrap(
        await commands.readFileAtRevision(repo.ctx, '/bin.dat', { kind: 'head' }),
      );
      expect(file).to.deep.equal({ content: null, binary: true });
    });

    it('reads the staged copy for the index revision', async () => {
      write(repo.dir, 'note.md', 'staged\n');
      unwrap(await commands.stage(repo.ctx, ['/note.md']));
      write(repo.dir, 'note.md', 'worktree\n');

      const staged = unwrap(
        await commands.readFileAtRevision(repo.ctx, '/note.md', { kind: 'index' }),
      );
      expect(staged).to.deep.equal({ content: 'staged\n', binary: false });

      const head = unwrap(
        await commands.readFileAtRevision(repo.ctx, '/note.md', { kind: 'head' }),
      );
      expect(head).to.deep.equal({ content: 'v2\n', binary: false });
    });
  });

  describe('remotes and push', () => {
    let repo: Fixture;
    let defaultBranch = '';

    before(async () => {
      repo = await makeRepo();
      write(repo.dir, 'base.md', 'base\n');
      unwrap(await commands.commit(repo.ctx, 'base commit', ['/base.md']));
      defaultBranch = unwrap(await commands.status(repo.ctx)).branch as string;
    });

    it('returns an empty list when no remotes are configured', async () => {
      expect(unwrap(await commands.listRemotes(repo.ctx))).to.deep.equal([]);
    });

    it('parses an https remote into a web location', async () => {
      git(repo.dir, 'remote', 'add', 'origin', 'https://github.com/foo/bar.git');
      try {
        const remotes = unwrap(await commands.listRemotes(repo.ctx));
        expect(remotes).to.deep.equal([
          {
            name: 'origin',
            fetchUrl: 'https://github.com/foo/bar.git',
            pushUrl: 'https://github.com/foo/bar.git',
            web: {
              host: 'github.com',
              owner: 'foo',
              repo: 'bar',
              webUrl: 'https://github.com/foo/bar',
            },
          },
        ]);
      } finally {
        git(repo.dir, 'remote', 'remove', 'origin');
      }
    });

    it('pushes with setUpstream to a local file-path remote', async () => {
      const bare = path.join(tmpBase, `bare-${path.basename(repo.dir)}.git`);
      execFileSync('git', ['init', '--bare', bare], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        stdio: 'ignore',
      });
      git(repo.dir, 'remote', 'add', 'origin', bare);

      unwrap(await commands.push(repo.ctx, { setUpstream: true }));

      const status = unwrap(await commands.status(repo.ctx));
      expect(status.upstream).to.equal(`origin/${defaultBranch}`);
      expect(status.ahead).to.equal(0);
      expect(status.behind).to.equal(0);

      // File-path remotes have no web mapping.
      const remotes = unwrap(await commands.listRemotes(repo.ctx));
      expect(remotes[0]?.web).to.equal(null);
    });
  });

  describe('merge conflicts', () => {
    let repo: Fixture;
    let defaultBranch = '';

    before(async () => {
      repo = await makeRepo();
      write(repo.dir, 'conflict.md', 'base\n');
      unwrap(await commands.commit(repo.ctx, 'base commit', ['/conflict.md']));
      defaultBranch = unwrap(await commands.status(repo.ctx)).branch as string;

      unwrap(await commands.createBranch(repo.ctx, 'other'));
      write(repo.dir, 'conflict.md', 'other-line\n');
      unwrap(await commands.commit(repo.ctx, 'other edit', ['/conflict.md']));

      unwrap(await commands.checkoutBranch(repo.ctx, defaultBranch));
      write(repo.dir, 'conflict.md', 'main-line\n');
      unwrap(await commands.commit(repo.ctx, 'main edit', ['/conflict.md']));
    });

    it('reports an in-progress merge with conflicted entries', async () => {
      try {
        git(repo.dir, 'merge', 'other');
        throw new Error('expected the merge to conflict');
      } catch {
        // conflict expected
      }

      const status = unwrap(await commands.status(repo.ctx));
      expect(status.operation).to.equal('merge');
      expect(status.changes).to.deep.equal([
        {
          path: '/conflict.md',
          origPath: undefined,
          index: 'unmerged',
          worktree: 'unmerged',
          conflicted: true,
        },
      ]);
    });

    it('concludes the merge once the resolution is staged and committed', async () => {
      write(repo.dir, 'conflict.md', 'resolved\n');
      unwrap(await commands.stage(repo.ctx, ['/conflict.md']));
      const { sha } = unwrap(await commands.commit(repo.ctx, 'merge concluded'));
      expect(sha).to.match(SHA_RE);

      const status = unwrap(await commands.status(repo.ctx));
      expect(status.operation).to.equal(null);
      expect(status.changes).to.deep.equal([]);
    });
  });
});
