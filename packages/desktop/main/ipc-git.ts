/**
 * IPC handlers for git operations.
 *
 * Thin Electron shim over main/git/commands.ts: every root-scoped channel
 * validates the workspace root against the whitelist first, resolves a
 * cached RepoContext, and delegates. Expected git failures travel back as
 * GitResult data; throwing is reserved for contract violations
 * (unregistered root, path escape).
 *
 * Also owns the throttled per-root status stream (repo watcher + shared
 * workspace watcher + post-mutation pokes) and the clone / gh helpers.
 */

import { BrowserWindow, dialog, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ElectronWorkspaceInfo,
  GitCapabilities,
  GitErrorCode,
  GitLogOptions,
  GitRepoDetection,
  GitResult,
  GitRevision,
} from '@bendyline/docblocks/host';

import { getWorkspaceRoots } from './workspace-roots.js';
import { acquireWorkspaceWatcher, type WorkspaceWatcherHandle } from './workspace-watchers.js';
import { registerAndPersistWorkspace } from './ipc-workspaces.js';
import { readSettings, updateSettings } from './settings.js';
import { detectGh, detectGit, gitFeaturesDisabled } from './git/detect.js';
import * as git from './git/commands.js';
import type { RepoContext } from './git/commands.js';
import { gitEnv, trackGitChild } from './git/exec.js';
import { createRepoWatcher, type RepoWatcher } from './git/repo-watcher.js';
import { createCloneProgressParser } from './git/clone-progress.js';
import { deriveRepoDirName } from './git/parse-remote-url.js';
import { isValidCloneUrl } from './git/validate.js';
import { makeGitError } from './git/errors.js';

const STATUS_THROTTLE_MS = 400;

function fail<T>(code: GitErrorCode, message: string): GitResult<T> {
  return { ok: false, error: { code, message } };
}

async function gitBinOrNull(): Promise<string | null> {
  const detected = await detectGit();
  return detected?.path ?? null;
}

/** Positive repo contexts cached per resolved root; cleared on repo errors. */
const contexts = new Map<string, RepoContext>();

async function getContext(rootPath: string): Promise<GitResult<RepoContext>> {
  const abs = getWorkspaceRoots().resolve(rootPath, '');
  const bin = await gitBinOrNull();
  if (!bin) return fail('git-not-available', 'Git is not available');
  const cached = contexts.get(abs);
  if (cached) return { ok: true, value: cached };
  const { context } = await git.detectRepo(bin, abs);
  if (!context) return fail('not-a-repository', 'This folder is not a git repository');
  contexts.set(abs, context);
  return { ok: true, value: context };
}

async function withContext<T>(
  rootPath: string,
  fn: (ctx: RepoContext) => Promise<GitResult<T>>,
  opts?: { poke?: boolean },
): Promise<GitResult<T>> {
  const ctx = await getContext(rootPath);
  if (!ctx.ok) return ctx as GitResult<T>;
  try {
    const result = await fn(ctx.value);
    if (!result.ok && result.error.code === 'not-a-repository') {
      contexts.delete(ctx.value.workspaceRoot);
    }
    return result;
  } catch (err) {
    return fail('unknown', err instanceof Error ? err.message : 'git operation failed');
  } finally {
    if (opts?.poke) pokeStatus(ctx.value.workspaceRoot);
  }
}

// ── Status stream ───────────────────────────────────────────────

interface StatusState {
  /** Resolved absolute root. */
  rootPath: string;
  subscriptions: Set<string>;
  wsHandle: WorkspaceWatcherHandle;
  wsUnsubscribe: () => void;
  repoWatcher: RepoWatcher | null;
  timer: NodeJS.Timeout | null;
  running: boolean;
  again: boolean;
}

const statusStates = new Map<string, StatusState>();

function pokeStatus(absRoot: string): void {
  const state = statusStates.get(path.resolve(absRoot));
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    void recomputeStatus(state);
  }, STATUS_THROTTLE_MS);
  state.timer.unref();
}

async function recomputeStatus(state: StatusState): Promise<void> {
  if (state.running) {
    state.again = true;
    return;
  }
  state.running = true;
  try {
    let ctx: GitResult<RepoContext>;
    try {
      ctx = await getContext(state.rootPath);
    } catch {
      return; // root was unregistered while subscribed
    }
    if (!ctx.ok) return;
    if (!state.repoWatcher) {
      // The folder became a repo after subscribe (git init) — attach now.
      state.repoWatcher = createRepoWatcher({
        gitDir: ctx.value.gitDir,
        commonDir: ctx.value.commonDir,
        onChange: () => pokeStatus(state.rootPath),
      });
    }
    const result = await git.status(ctx.value);
    if (result.ok) {
      for (const subscriptionId of state.subscriptions) {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('git:status:event', { subscriptionId, status: result.value });
        }
      }
    } else if (result.error.code === 'not-a-repository') {
      contexts.delete(state.rootPath);
    }
  } finally {
    state.running = false;
    if (state.again) {
      state.again = false;
      void recomputeStatus(state);
    }
  }
}

function releaseStatusSubscription(absRoot: string, subscriptionId: string): void {
  const state = statusStates.get(absRoot);
  if (!state) return;
  state.subscriptions.delete(subscriptionId);
  if (state.subscriptions.size === 0) {
    if (state.timer) clearTimeout(state.timer);
    state.wsUnsubscribe();
    state.wsHandle.release();
    void state.repoWatcher?.close();
    statusStates.delete(absRoot);
  }
}

// ── Clone bookkeeping ───────────────────────────────────────────

interface CloneOperation {
  child: ReturnType<typeof spawn>;
  targetDir: string;
  cancelled: boolean;
  untrack: () => void;
}

const cloneOperations = new Map<string, CloneOperation>();

async function isNonEmptyDir(candidate: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(candidate);
    return entries.length > 0;
  } catch {
    return false;
  }
}

// ── gh helper ───────────────────────────────────────────────────

function runTool(
  bin: string,
  args: string[],
  cwd: string,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...gitEnv(), ...extraEnv },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    const untrack = trackGitChild(child);
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', () => {
      untrack();
      resolve({ code: null, stderr });
    });
    child.on('close', (code) => {
      untrack();
      resolve({ code, stderr });
    });
  });
}

const GH_ENV: NodeJS.ProcessEnv = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1',
};

function classifyGhError(stderr: string): GitErrorCode {
  if (/gh auth login|not logged in|authentication|HTTP 401/i.test(stderr)) return 'auth-failed';
  if (/already exists/i.test(stderr)) return 'pr-exists';
  if (/no upstream|is not tracking|no commits between/i.test(stderr)) return 'no-upstream';
  return 'unknown';
}

// ── Registration ────────────────────────────────────────────────

export function registerGitIpc(): void {
  const roots = getWorkspaceRoots();

  ipcMain.handle('git:capabilities', async (): Promise<GitCapabilities> => {
    if (gitFeaturesDisabled()) {
      return { gitAvailable: false, gitVersion: null, ghAvailable: false, ghVersion: null };
    }
    const [gitTool, ghTool] = await Promise.all([detectGit(), detectGh()]);
    return {
      gitAvailable: gitTool !== null,
      gitVersion: gitTool?.version ?? null,
      ghAvailable: ghTool !== null,
      ghVersion: ghTool?.version ?? null,
    };
  });

  ipcMain.handle(
    'git:detectRepo',
    async (_e, rootPath: string): Promise<GitResult<GitRepoDetection>> => {
      const abs = roots.resolve(rootPath, '');
      const bin = await gitBinOrNull();
      if (!bin) return fail('git-not-available', 'Git is not available');
      const { detection, context } = await git.detectRepo(bin, abs);
      if (context) contexts.set(abs, context);
      else contexts.delete(abs);
      return { ok: true, value: detection };
    },
  );

  ipcMain.handle('git:init', async (_e, rootPath: string): Promise<GitResult<void>> => {
    const abs = roots.resolve(rootPath, '');
    const bin = await gitBinOrNull();
    if (!bin) return fail('git-not-available', 'Git is not available');
    const result = await git.init(bin, abs);
    if (result.ok) {
      contexts.delete(abs);
      pokeStatus(abs);
    }
    return result;
  });

  ipcMain.handle('git:status', (_e, rootPath: string) =>
    withContext(rootPath, (ctx) => git.status(ctx)),
  );

  ipcMain.handle('git:stage', (_e, rootPath: string, paths: string[]) =>
    withContext(rootPath, (ctx) => git.stage(ctx, paths), { poke: true }),
  );

  ipcMain.handle('git:unstage', (_e, rootPath: string, paths: string[]) =>
    withContext(rootPath, (ctx) => git.unstage(ctx, paths), { poke: true }),
  );

  ipcMain.handle('git:discard', (_e, rootPath: string, paths: string[]) =>
    withContext(rootPath, (ctx) => git.discard(ctx, paths), { poke: true }),
  );

  ipcMain.handle('git:commit', (_e, rootPath: string, message: string, paths?: string[]) =>
    withContext(rootPath, (ctx) => git.commit(ctx, message, paths), { poke: true }),
  );

  ipcMain.handle('git:push', (_e, rootPath: string, opts?: { setUpstream?: boolean }) =>
    withContext(rootPath, (ctx) => git.push(ctx, opts), { poke: true }),
  );

  ipcMain.handle('git:pull', (_e, rootPath: string) =>
    withContext(rootPath, (ctx) => git.pull(ctx), { poke: true }),
  );

  ipcMain.handle('git:fetch', (_e, rootPath: string) =>
    withContext(rootPath, (ctx) => git.fetch(ctx), { poke: true }),
  );

  ipcMain.handle('git:listBranches', (_e, rootPath: string) =>
    withContext(rootPath, (ctx) => git.listBranches(ctx)),
  );

  ipcMain.handle(
    'git:createBranch',
    (_e, rootPath: string, name: string, opts?: { checkout?: boolean }) =>
      withContext(rootPath, (ctx) => git.createBranch(ctx, name, opts), { poke: true }),
  );

  ipcMain.handle('git:checkoutBranch', (_e, rootPath: string, name: string) =>
    withContext(rootPath, (ctx) => git.checkoutBranch(ctx, name), { poke: true }),
  );

  ipcMain.handle('git:log', (_e, rootPath: string, opts?: GitLogOptions) =>
    withContext(rootPath, (ctx) => git.log(ctx, opts)),
  );

  ipcMain.handle('git:commitFiles', (_e, rootPath: string, sha: string) =>
    withContext(rootPath, (ctx) => git.commitFiles(ctx, sha)),
  );

  ipcMain.handle(
    'git:readFileAtRevision',
    (_e, rootPath: string, filePath: string, revision: GitRevision) =>
      withContext(rootPath, (ctx) => git.readFileAtRevision(ctx, filePath, revision)),
  );

  ipcMain.handle('git:listRemotes', (_e, rootPath: string) =>
    withContext(rootPath, (ctx) => git.listRemotes(ctx)),
  );

  // ── Status subscription ───────────────────────────────────────

  ipcMain.handle(
    'git:status:subscribe',
    async (event, rootPath: string, subscriptionId: string) => {
      const abs = roots.resolve(rootPath, '');
      let state = statusStates.get(abs);
      if (!state) {
        const wsHandle = acquireWorkspaceWatcher(abs);
        const created: StatusState = {
          rootPath: abs,
          subscriptions: new Set(),
          wsHandle,
          wsUnsubscribe: () => undefined,
          repoWatcher: null,
          timer: null,
          running: false,
          again: false,
        };
        created.wsUnsubscribe = wsHandle.onChange(() => pokeStatus(abs));
        const ctx = await getContext(abs);
        if (ctx.ok) {
          created.repoWatcher = createRepoWatcher({
            gitDir: ctx.value.gitDir,
            commonDir: ctx.value.commonDir,
            onChange: () => pokeStatus(abs),
          });
        }
        statusStates.set(abs, created);
        state = created;
      }
      state.subscriptions.add(subscriptionId);
      event.sender.once('destroyed', () => releaseStatusSubscription(abs, subscriptionId));

      // Immediate first emission for this subscriber.
      const first = await withContext(abs, (ctx) => git.status(ctx));
      if (first.ok) {
        event.sender.send('git:status:event', { subscriptionId, status: first.value });
      }
    },
  );

  ipcMain.handle('git:status:unsubscribe', async (_e, rootPath: string, subscriptionId: string) => {
    releaseStatusSubscription(path.resolve(rootPath), subscriptionId);
  });

  // ── Clone ─────────────────────────────────────────────────────

  ipcMain.handle(
    'git:clone',
    async (
      event,
      url: string,
      operationId: string,
    ): Promise<GitResult<ElectronWorkspaceInfo | null>> => {
      const bin = await gitBinOrNull();
      if (!bin) return fail('git-not-available', 'Git is not available');
      if (typeof url !== 'string' || !isValidCloneUrl(url)) {
        return fail('invalid-url', 'That does not look like a clonable repository URL');
      }

      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const settings = await readSettings();
      const picked = await dialog.showOpenDialog(win!, {
        title: 'Choose where to clone',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: settings.lastCloneParentDir,
      });
      if (picked.canceled || picked.filePaths.length === 0) {
        return { ok: true, value: null };
      }
      const parentDir = picked.filePaths[0];
      const targetDir = path.join(parentDir, deriveRepoDirName(url));
      if (await isNonEmptyDir(targetDir)) {
        return fail('destination-exists', `${path.basename(targetDir)} already exists there`);
      }

      const child = spawn(bin, ['clone', '--progress', '--', url, targetDir], {
        cwd: parentDir,
        env: gitEnv(),
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      const untrack = trackGitChild(child);
      const operation: CloneOperation = { child, targetDir, cancelled: false, untrack };
      cloneOperations.set(operationId, operation);

      const parseProgress = createCloneProgressParser((progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('git:clone:progress', { operationId, ...progress });
        }
      });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (stderr.length < 64 * 1024) stderr += text;
        parseProgress(text);
      });

      const code = await new Promise<number | null>((resolve) => {
        child.on('error', () => resolve(null));
        child.on('close', (exitCode) => resolve(exitCode));
      });
      untrack();
      cloneOperations.delete(operationId);

      if (operation.cancelled) {
        await fs.rm(targetDir, { recursive: true, force: true });
        return fail('cancelled', 'Clone cancelled');
      }
      if (code !== 0) {
        await fs.rm(targetDir, { recursive: true, force: true });
        return { ok: false, error: makeGitError(code, stderr, 'git clone failed') };
      }

      const info = await registerAndPersistWorkspace(targetDir);
      await updateSettings((s) => ({ ...s, lastCloneParentDir: parentDir }));
      return { ok: true, value: info };
    },
  );

  ipcMain.handle('git:clone:cancel', async (_e, operationId: string) => {
    const operation = cloneOperations.get(operationId);
    if (!operation) return;
    operation.cancelled = true;
    operation.child.kill('SIGTERM');
  });

  // ── Pull request via gh ───────────────────────────────────────

  ipcMain.handle(
    'git:createPullRequest',
    async (_e, rootPath: string): Promise<GitResult<void>> => {
      const ctx = await getContext(rootPath);
      if (!ctx.ok) return ctx as GitResult<void>;
      const gh = await detectGh();
      if (!gh) return fail('gh-not-available', 'GitHub CLI (gh) is not installed');

      const current = await git.status(ctx.value);
      if (current.ok && current.value.upstream === null) {
        return fail('no-upstream', 'Publish the branch before creating a pull request');
      }

      const created = await runTool(
        gh.path,
        ['pr', 'create', '--web'],
        ctx.value.workspaceRoot,
        GH_ENV,
      );
      if (created.code === 0) return { ok: true, value: undefined };
      if (/already exists/i.test(created.stderr)) {
        const viewed = await runTool(
          gh.path,
          ['pr', 'view', '--web'],
          ctx.value.workspaceRoot,
          GH_ENV,
        );
        if (viewed.code === 0) return { ok: true, value: undefined };
      }
      const code = classifyGhError(created.stderr);
      return {
        ok: false,
        error: {
          code,
          message:
            code === 'auth-failed'
              ? 'GitHub CLI is not signed in — run `gh auth login`'
              : 'Could not create the pull request',
          stderr: created.stderr.slice(0, 8192) || undefined,
          exitCode: created.code ?? undefined,
        },
      };
    },
  );
}
