/**
 * IPC handlers for git operations.
 *
 * Thin Electron shim over main/git/commands.ts. Detection accepts only a
 * registered workspace id, resolves physical Git metadata in main, withholds
 * the grant until the user has allowed expanding into a parent repository,
 * and returns an owner-scoped opaque repository grant. Every later operation
 * revalidates that grant.
 *
 * Also owns the throttled per-repository status stream (repo watcher + shared
 * workspace watcher + post-mutation pokes) and the clone / gh helpers.
 */

import {
  BrowserWindow,
  dialog,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type WebContents,
} from 'electron';
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
import { HOST_WIRE_LIMITS, isBoundedString, parseExternalHttpUrl } from '@bendyline/docblocks/host';

import { getWorkspaceRoots, isPathInside } from './workspace-roots.js';
import { acquireWorkspaceWatcher, type WorkspaceWatcherHandle } from './workspace-watchers.js';
import { registerAndPersistWorkspace } from './ipc-workspaces.js';
import { readSettings, updateSettings } from './settings.js';
import { detectGh, detectGit, gitFeaturesDisabled } from './git/detect.js';
import * as git from './git/commands.js';
import type { RepoContext } from './git/commands.js';
import { gitEnv, trackGitChild } from './git/exec.js';
import { createRepoWatcher, type RepoWatcher } from './git/repo-watcher.js';
import { createCloneProgressParser } from './git/clone-progress.js';
import { CloneDestination, CloneDestinationExistsError } from './git/clone-destination.js';
import { deriveRepoDirName } from './git/parse-remote-url.js';
import { isValidCloneUrl } from './git/validate.js';
import { makeGitError, redactGitOutput } from './git/errors.js';
import { registerTrustedIpcHandler } from './ipc-authority.js';
import { OwnerGrantStore } from './owner-grants.js';
import { bindOwnerGrantRevocation } from './owner-revocation.js';

const STATUS_THROTTLE_MS = 400;
const GH_TIMEOUT_MS = 120_000;
const GH_OUTPUT_LIMIT = 1024 * 1024;
const CLONE_TIMEOUT_MS = 10 * 60_000;

function fail<T>(code: GitErrorCode, message: string): GitResult<T> {
  return { ok: false, error: { code, message } };
}

async function gitBinOrNull(): Promise<string | null> {
  const detected = await detectGit();
  return detected?.path ?? null;
}

interface RepositoryGrant {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly toplevel: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly context: RepoContext;
}

interface GrantedRepository extends RepositoryGrant {
  readonly id: string;
}

/** How many individually-allowed repositories are remembered on disk. */
const EXPANDED_GRANT_MEMORY_LIMIT = 100;

const repositoryGrants = new OwnerGrantStore<RepositoryGrant>('repo');
const registeredGrantOwners = new Set<number>();

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function workspaceEntry(workspaceId: unknown): { id: string; rootPath: string } {
  if (!isBoundedString(workspaceId, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
    throw new Error('Invalid workspace capability');
  }
  const entry = getWorkspaceRoots().get(workspaceId);
  if (!entry) throw new Error('Workspace capability is not registered');
  return entry;
}

async function resolveWorkspace(workspaceId: unknown): Promise<{ id: string; rootPath: string }> {
  const entry = workspaceEntry(workspaceId);
  const physical = await getWorkspaceRoots().resolvePhysical(entry.rootPath, '');
  return { id: entry.id, rootPath: await fs.realpath(physical) };
}

function requiresExpandedGrant(context: RepoContext): boolean {
  return (
    !samePath(context.workspaceRoot, context.toplevel) ||
    !isPathInside(context.workspaceRoot, context.gitDir) ||
    !isPathInside(context.workspaceRoot, context.commonDir)
  );
}

/**
 * Consent for expanding past the workspace grant is *remembered*, never
 * prompted for at open time: opening a folder inside a big repository used to
 * throw a modal in the user's face before they had done anything. Detection
 * now reports the ungranted state, the renderer shows a status-bar warning,
 * and the grant is minted from an explicit click through `git:grantExpandedRepo`.
 */
async function expandedGrantRemembered(toplevel: string): Promise<boolean> {
  const settings = await readSettings();
  if (settings.git?.allowExpandedByDefault === true) return true;
  return (settings.git?.allowedRepositories ?? []).some((allowed) => samePath(allowed, toplevel));
}

async function rememberExpandedGrant(toplevel: string, always: boolean): Promise<void> {
  await updateSettings((current) => {
    const previous = current.git ?? {};
    const allowed = (previous.allowedRepositories ?? []).filter(
      (entry) => !samePath(entry, toplevel),
    );
    allowed.push(toplevel);
    // Bounded like every other persisted list — keep the most recent grants.
    const trimmed = allowed.slice(-EXPANDED_GRANT_MEMORY_LIMIT);
    return {
      ...current,
      git: {
        ...previous,
        ...(always ? { allowExpandedByDefault: true } : {}),
        allowedRepositories: trimmed,
      },
    };
  });
}

function registerGrantOwner(sender: WebContents): void {
  if (registeredGrantOwners.has(sender.id)) return;
  registeredGrantOwners.add(sender.id);
  bindOwnerGrantRevocation(sender, () => {
    for (const repositoryId of repositoryGrants.revokeOwner(sender.id)) {
      releaseAllStatusSubscriptions(repositoryId);
    }
  });
  sender.once('destroyed', () => registeredGrantOwners.delete(sender.id));
}

function mintRepositoryGrant(
  event: IpcMainInvokeEvent,
  workspaceId: string,
  context: RepoContext,
): GrantedRepository {
  registerGrantOwner(event.sender);
  const grant: RepositoryGrant = {
    workspaceId,
    workspaceRoot: context.workspaceRoot,
    toplevel: context.toplevel,
    gitDir: context.gitDir,
    commonDir: context.commonDir,
    context,
  };
  const id = repositoryGrants.mint(event.sender.id, grant);
  return { id, ...grant };
}

async function revalidateGrant(grant: RepositoryGrant): Promise<RepoContext> {
  const workspace = await resolveWorkspace(grant.workspaceId);
  if (!samePath(workspace.rootPath, grant.workspaceRoot)) {
    throw new Error('Workspace physical identity changed');
  }
  const { context } = await git.detectRepo(grant.context.gitBin, workspace.rootPath);
  if (
    !context ||
    !samePath(context.toplevel, grant.toplevel) ||
    !samePath(context.gitDir, grant.gitDir) ||
    !samePath(context.commonDir, grant.commonDir)
  ) {
    throw new Error('Repository physical identity changed');
  }
  return context;
}

async function getGrantedContext(
  event: IpcMainInvokeEvent,
  repositoryId: unknown,
): Promise<GitResult<GrantedRepository>> {
  if (!isBoundedString(repositoryId, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
    return fail('permission-denied', 'Invalid repository capability');
  }
  const grant = repositoryGrants.get(event.sender.id, repositoryId);
  if (!grant) {
    return fail('permission-denied', 'Repository capability is unavailable');
  }
  try {
    const context = await revalidateGrant(grant);
    return { ok: true, value: { id: repositoryId, ...grant, context } };
  } catch {
    repositoryGrants.revoke(event.sender.id, repositoryId);
    releaseAllStatusSubscriptions(repositoryId);
    return fail('permission-denied', 'Repository capability is stale');
  }
}

async function withRepository<T>(
  event: IpcMainInvokeEvent,
  repositoryId: unknown,
  fn: (ctx: RepoContext) => Promise<GitResult<T>>,
  opts?: { poke?: boolean },
): Promise<GitResult<T>> {
  const granted = await getGrantedContext(event, repositoryId);
  if (!granted.ok) return granted as GitResult<T>;
  try {
    const result = await fn(granted.value.context);
    if (!result.ok && result.error.code === 'not-a-repository') {
      repositoryGrants.revoke(event.sender.id, granted.value.id);
    }
    return result;
  } catch (err) {
    return fail('unknown', err instanceof Error ? err.message : 'git operation failed');
  } finally {
    if (opts?.poke) pokeStatus(granted.value.id);
  }
}

// ── Status stream ───────────────────────────────────────────────

interface StatusState {
  repositoryId: string;
  owner: WebContents;
  subscriptions: Set<string>;
  wsHandle: WorkspaceWatcherHandle;
  wsUnsubscribe: () => void;
  repoWatcher: RepoWatcher | null;
  timer: NodeJS.Timeout | null;
  running: boolean;
  again: boolean;
}

const statusStates = new Map<string, StatusState>();

function pokeStatus(repositoryId: string): void {
  const state = statusStates.get(repositoryId);
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
      const grant = repositoryGrants.get(state.owner.id, state.repositoryId);
      if (!grant) return;
      ctx = { ok: true, value: await revalidateGrant(grant) };
    } catch {
      return; // root was unregistered while subscribed
    }
    if (!ctx.ok) return;
    if (!state.repoWatcher) {
      // The folder became a repo after subscribe (git init) — attach now.
      state.repoWatcher = createRepoWatcher({
        gitDir: ctx.value.gitDir,
        commonDir: ctx.value.commonDir,
        onChange: () => pokeStatus(state.repositoryId),
      });
    }
    const result = await git.status(ctx.value);
    if (result.ok) {
      if (!state.owner.isDestroyed()) {
        for (const subscriptionId of state.subscriptions) {
          state.owner.send('git:status:event', { subscriptionId, status: result.value });
        }
      }
    } else if (result.error.code === 'not-a-repository') {
      repositoryGrants.revoke(state.owner.id, state.repositoryId);
    }
  } finally {
    state.running = false;
    if (state.again) {
      state.again = false;
      void recomputeStatus(state);
    }
  }
}

function releaseStatusSubscription(repositoryId: string, subscriptionId: string): void {
  const state = statusStates.get(repositoryId);
  if (!state) return;
  state.subscriptions.delete(subscriptionId);
  if (state.subscriptions.size === 0) {
    if (state.timer) clearTimeout(state.timer);
    state.wsUnsubscribe();
    state.wsHandle.release();
    void state.repoWatcher?.close();
    statusStates.delete(repositoryId);
  }
}

function releaseAllStatusSubscriptions(repositoryId: string): void {
  const state = statusStates.get(repositoryId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.wsUnsubscribe();
  state.wsHandle.release();
  void state.repoWatcher?.close();
  statusStates.delete(repositoryId);
}

// ── Clone bookkeeping ───────────────────────────────────────────

interface CloneOperation {
  child: ReturnType<typeof spawn>;
  destination: CloneDestination;
  ownerId: number;
  cancelled: boolean;
  timedOut: boolean;
  untrack: () => void;
}

const cloneOperations = new Map<string, CloneOperation>();
const registeredCloneOwners = new Set<number>();

function terminateClone(operationId: string, operation: CloneOperation): void {
  operation.child.kill('SIGTERM');
  setTimeout(() => {
    if (cloneOperations.get(operationId) === operation) operation.child.kill('SIGKILL');
  }, 5_000).unref();
}

function registerCloneOwner(sender: WebContents): void {
  if (registeredCloneOwners.has(sender.id)) return;
  registeredCloneOwners.add(sender.id);
  bindOwnerGrantRevocation(sender, () => {
    for (const [operationId, operation] of cloneOperations) {
      if (operation.ownerId !== sender.id) continue;
      operation.cancelled = true;
      terminateClone(operationId, operation);
    }
  });
  sender.once('destroyed', () => registeredCloneOwners.delete(sender.id));
}

// ── gh helper ───────────────────────────────────────────────────

function runTool(
  bin: string,
  args: string[],
  cwd: string,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...gitEnv(), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const untrack = trackGitChild(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      untrack();
      resolve({ code, stdout, stderr });
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
          finish(null);
        }
      }, 5_000).unref();
    }, GH_TIMEOUT_MS);
    timeout.unref();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length >= GH_OUTPUT_LIMIT) return;
      stdout += chunk.toString('utf8').slice(0, GH_OUTPUT_LIMIT - stdout.length);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length >= GH_OUTPUT_LIMIT) return;
      stderr += chunk.toString('utf8').slice(0, GH_OUTPUT_LIMIT - stderr.length);
    });
    child.on('error', () => finish(null));
    child.on('close', finish);
  });
}

const GH_ENV: NodeJS.ProcessEnv = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1',
};

function repositoryToolEnvironment(context: RepoContext): NodeJS.ProcessEnv {
  return {
    ...GH_ENV,
    GIT_DIR: context.gitDir,
    GIT_WORK_TREE: context.toplevel,
    GIT_DISCOVERY_ACROSS_FILESYSTEM: '0',
  };
}

function classifyGhError(stderr: string): GitErrorCode {
  if (/gh auth login|not logged in|authentication|HTTP 401/i.test(stderr)) return 'auth-failed';
  if (/already exists/i.test(stderr)) return 'pr-exists';
  if (/no upstream|is not tracking|no commits between/i.test(stderr)) return 'no-upstream';
  return 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function parsePaths(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > HOST_WIRE_LIMITS.arrayEntries) {
    return null;
  }
  return value.every((entry) => isBoundedString(entry, HOST_WIRE_LIMITS.pathCharacters, 1))
    ? value
    : null;
}

function withValidatedPaths<T>(
  event: IpcMainInvokeEvent,
  repositoryId: unknown,
  value: unknown,
  operation: (context: RepoContext, paths: string[]) => Promise<GitResult<T>>,
  poke = true,
): Promise<GitResult<T>> | GitResult<T> {
  const paths = parsePaths(value);
  if (!paths) return fail('unknown', 'Invalid repository paths');
  return withRepository(event, repositoryId, (context) => operation(context, paths), { poke });
}

function parsePushOptions(value: unknown): { setUpstream?: boolean } | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ['setUpstream'])) return null;
  if (value.setUpstream !== undefined && typeof value.setUpstream !== 'boolean') return null;
  return value.setUpstream === undefined ? {} : { setUpstream: value.setUpstream };
}

function parseCreateBranchOptions(value: unknown): { checkout?: boolean } | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ['checkout'])) return null;
  if (value.checkout !== undefined && typeof value.checkout !== 'boolean') return null;
  return value.checkout === undefined ? {} : { checkout: value.checkout };
}

function parseLogOptions(value: unknown): GitLogOptions | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ['path', 'maxCount', 'skip'])) return null;
  if (
    value.path !== undefined &&
    !isBoundedString(value.path, HOST_WIRE_LIMITS.pathCharacters, 1)
  ) {
    return null;
  }
  if (
    value.maxCount !== undefined &&
    (typeof value.maxCount !== 'number' ||
      !Number.isSafeInteger(value.maxCount) ||
      value.maxCount < 1 ||
      value.maxCount > 1_000)
  ) {
    return null;
  }
  if (
    value.skip !== undefined &&
    (typeof value.skip !== 'number' ||
      !Number.isSafeInteger(value.skip) ||
      value.skip < 0 ||
      value.skip > 1_000_000)
  ) {
    return null;
  }
  return {
    ...(typeof value.path === 'string' ? { path: value.path } : {}),
    ...(typeof value.maxCount === 'number' ? { maxCount: value.maxCount } : {}),
    ...(typeof value.skip === 'number' ? { skip: value.skip } : {}),
  };
}

function parseRevision(value: unknown): GitRevision | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'head' || value.kind === 'index') {
    return hasOnlyKeys(value, ['kind']) ? { kind: value.kind } : null;
  }
  if (value.kind !== 'commit' && value.kind !== 'parent-of') return null;
  if (!hasOnlyKeys(value, ['kind', 'sha']) || !isBoundedString(value.sha, 64, 4)) return null;
  return { kind: value.kind, sha: value.sha };
}

// ── Registration ────────────────────────────────────────────────

export function registerGitIpc(): void {
  registerTrustedIpcHandler('git:capabilities', 0, async (): Promise<GitCapabilities> => {
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

  registerTrustedIpcHandler(
    'git:detectRepo',
    1,
    async (event, workspaceId: unknown): Promise<GitResult<GitRepoDetection>> => {
      const bin = await gitBinOrNull();
      if (!bin) return fail('git-not-available', 'Git is not available');
      try {
        const workspace = await resolveWorkspace(workspaceId);
        const { detection, context } = await git.detectRepo(bin, workspace.rootPath);
        if (!context || !detection.isRepo) return { ok: true, value: { isRepo: false } };
        const expanded = requiresExpandedGrant(context);
        const existing = repositoryGrants
          .entries(event.sender.id)
          .find(
            ({ value: grant }) =>
              grant.workspaceId === workspace.id &&
              samePath(grant.workspaceRoot, context.workspaceRoot) &&
              samePath(grant.toplevel, context.toplevel) &&
              samePath(grant.gitDir, context.gitDir) &&
              samePath(grant.commonDir, context.commonDir),
          );
        if (existing) {
          await revalidateGrant(existing.value);
          return {
            ok: true,
            value: {
              isRepo: true,
              rootIsToplevel: detection.rootIsToplevel,
              repositoryId: existing.grantId,
              requiresExpandedGrant: expanded,
            },
          };
        }
        if (expanded && !(await expandedGrantRemembered(context.toplevel))) {
          return {
            ok: true,
            value: {
              isRepo: true,
              rootIsToplevel: detection.rootIsToplevel,
              requiresExpandedGrant: true,
              repositoryRoot: context.toplevel,
            },
          };
        }
        const grant = mintRepositoryGrant(event, workspace.id, context);
        return {
          ok: true,
          value: {
            isRepo: true,
            rootIsToplevel: detection.rootIsToplevel,
            repositoryId: grant.id,
            requiresExpandedGrant: expanded,
          },
        };
      } catch (error: unknown) {
        return fail(
          'permission-denied',
          error instanceof Error ? error.message : 'Workspace capability is unavailable',
        );
      }
    },
  );

  registerTrustedIpcHandler(
    'git:grantExpandedRepo',
    [1, 2],
    async (event, workspaceId: unknown, opts?: unknown): Promise<GitResult<GitRepoDetection>> => {
      if (opts !== undefined && (!isRecord(opts) || !hasOnlyKeys(opts, ['always']))) {
        return fail('permission-denied', 'Invalid grant options');
      }
      const always = isRecord(opts) && opts.always === true;
      const bin = await gitBinOrNull();
      if (!bin) return fail('git-not-available', 'Git is not available');
      try {
        const workspace = await resolveWorkspace(workspaceId);
        const { detection, context } = await git.detectRepo(bin, workspace.rootPath);
        if (!context || !detection.isRepo) return { ok: true, value: { isRepo: false } };
        // The click is the consent; persist it before minting so a crash
        // can't leave the user re-answering a question they already answered.
        await rememberExpandedGrant(context.toplevel, always);
        const grant = mintRepositoryGrant(event, workspace.id, context);
        return {
          ok: true,
          value: {
            isRepo: true,
            rootIsToplevel: detection.rootIsToplevel,
            repositoryId: grant.id,
            requiresExpandedGrant: requiresExpandedGrant(context),
            repositoryRoot: context.toplevel,
          },
        };
      } catch (error: unknown) {
        return fail(
          'permission-denied',
          error instanceof Error ? error.message : 'Workspace capability is unavailable',
        );
      }
    },
  );

  registerTrustedIpcHandler(
    'git:init',
    1,
    async (_event, workspaceId: unknown): Promise<GitResult<void>> => {
      const bin = await gitBinOrNull();
      if (!bin) return fail('git-not-available', 'Git is not available');
      try {
        const workspace = await resolveWorkspace(workspaceId);
        return git.init(bin, workspace.rootPath);
      } catch (error: unknown) {
        return fail(
          'permission-denied',
          error instanceof Error ? error.message : 'Workspace capability is unavailable',
        );
      }
    },
  );

  registerTrustedIpcHandler('git:status', 1, (event, repositoryId: unknown) =>
    withRepository(event, repositoryId, (ctx) => git.status(ctx)),
  );

  registerTrustedIpcHandler('git:stage', 2, (event, repositoryId: unknown, paths: unknown) =>
    withValidatedPaths(event, repositoryId, paths, (ctx, validPaths) => git.stage(ctx, validPaths)),
  );

  registerTrustedIpcHandler('git:unstage', 2, (event, repositoryId: unknown, paths: unknown) =>
    withValidatedPaths(event, repositoryId, paths, (ctx, validPaths) =>
      git.unstage(ctx, validPaths),
    ),
  );

  registerTrustedIpcHandler('git:discard', 2, (event, repositoryId: unknown, paths: unknown) =>
    withValidatedPaths(event, repositoryId, paths, (ctx, validPaths) =>
      git.discard(ctx, validPaths),
    ),
  );

  registerTrustedIpcHandler(
    'git:commit',
    [2, 3],
    (event, repositoryId: unknown, message: unknown, paths?: unknown) => {
      if (!isBoundedString(message, 100 * 1024, 1)) {
        return fail('unknown', 'Invalid commit message');
      }
      if (paths === undefined) {
        return withRepository(event, repositoryId, (ctx) => git.commit(ctx, message), {
          poke: true,
        });
      }
      return withValidatedPaths(
        event,
        repositoryId,
        paths,
        (ctx, validPaths) => git.commit(ctx, message, validPaths),
        true,
      );
    },
  );

  registerTrustedIpcHandler('git:push', [1, 2], (event, repositoryId: unknown, opts?: unknown) => {
    const options = parsePushOptions(opts);
    if (options === null) return fail('unknown', 'Invalid push options');
    return withRepository(event, repositoryId, (ctx) => git.push(ctx, options), { poke: true });
  });

  registerTrustedIpcHandler('git:pull', 1, (event, repositoryId: unknown) =>
    withRepository(event, repositoryId, (ctx) => git.pull(ctx), { poke: true }),
  );

  registerTrustedIpcHandler('git:fetch', 1, (event, repositoryId: unknown) =>
    withRepository(event, repositoryId, (ctx) => git.fetch(ctx), { poke: true }),
  );

  registerTrustedIpcHandler('git:listBranches', 1, (event, repositoryId: unknown) =>
    withRepository(event, repositoryId, (ctx) => git.listBranches(ctx)),
  );

  registerTrustedIpcHandler(
    'git:createBranch',
    [2, 3],
    (event, repositoryId: unknown, name: unknown, opts?: unknown) => {
      if (!isBoundedString(name, 255, 1)) return fail('invalid-ref-name', 'Invalid branch name');
      const options = parseCreateBranchOptions(opts);
      if (options === null) return fail('unknown', 'Invalid branch options');
      return withRepository(event, repositoryId, (ctx) => git.createBranch(ctx, name, options), {
        poke: true,
      });
    },
  );

  registerTrustedIpcHandler(
    'git:checkoutBranch',
    2,
    (event, repositoryId: unknown, name: unknown) => {
      if (!isBoundedString(name, 255, 1)) return fail('invalid-ref-name', 'Invalid branch name');
      return withRepository(event, repositoryId, (ctx) => git.checkoutBranch(ctx, name), {
        poke: true,
      });
    },
  );

  registerTrustedIpcHandler('git:log', [1, 2], (event, repositoryId: unknown, opts?: unknown) => {
    const options = parseLogOptions(opts);
    if (options === null) return fail('unknown', 'Invalid log options');
    return withRepository(event, repositoryId, (ctx) => git.log(ctx, options));
  });

  registerTrustedIpcHandler('git:commitFiles', 2, (event, repositoryId: unknown, sha: unknown) => {
    if (!isBoundedString(sha, 64, 4)) return fail('unknown', 'Invalid commit id');
    return withRepository(event, repositoryId, (ctx) => git.commitFiles(ctx, sha));
  });

  registerTrustedIpcHandler(
    'git:readFileAtRevision',
    3,
    (event, repositoryId: unknown, filePath: unknown, revision: unknown) => {
      if (!isBoundedString(filePath, HOST_WIRE_LIMITS.pathCharacters, 1)) {
        return fail('unknown', 'Invalid repository path');
      }
      const validRevision = parseRevision(revision);
      if (!validRevision) return fail('unknown', 'Invalid revision selector');
      return withRepository(event, repositoryId, (ctx) =>
        git.readFileAtRevision(ctx, filePath, validRevision),
      );
    },
  );

  registerTrustedIpcHandler('git:listRemotes', 1, (event, repositoryId: unknown) =>
    withRepository(event, repositoryId, (ctx) => git.listRemotes(ctx)),
  );

  // ── Status subscription ───────────────────────────────────────

  registerTrustedIpcHandler(
    'git:status:subscribe',
    2,
    async (event, repositoryId: unknown, subscriptionId: unknown) => {
      if (!isBoundedString(subscriptionId, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
        return fail('unknown', 'Invalid subscription id');
      }
      const granted = await getGrantedContext(event, repositoryId);
      if (!granted.ok) return granted;
      let state = statusStates.get(granted.value.id);
      if (!state) {
        const wsHandle = acquireWorkspaceWatcher(granted.value.context.workspaceRoot);
        const created: StatusState = {
          repositoryId: granted.value.id,
          owner: event.sender,
          subscriptions: new Set(),
          wsHandle,
          wsUnsubscribe: () => undefined,
          repoWatcher: null,
          timer: null,
          running: false,
          again: false,
        };
        created.wsUnsubscribe = wsHandle.onChange(() => pokeStatus(granted.value.id));
        created.repoWatcher = createRepoWatcher({
          gitDir: granted.value.context.gitDir,
          commonDir: granted.value.context.commonDir,
          onChange: () => pokeStatus(granted.value.id),
        });
        statusStates.set(granted.value.id, created);
        state = created;
      }
      state.subscriptions.add(subscriptionId);
      event.sender.once('destroyed', () =>
        releaseStatusSubscription(granted.value.id, subscriptionId),
      );

      // Immediate first emission for this subscriber.
      const first = await git.status(granted.value.context);
      if (first.ok) {
        event.sender.send('git:status:event', { subscriptionId, status: first.value });
      }
      return { ok: true, value: undefined };
    },
  );

  registerTrustedIpcHandler(
    'git:status:unsubscribe',
    2,
    async (event, repositoryId: unknown, subscriptionId: unknown) => {
      if (
        !isBoundedString(repositoryId, HOST_WIRE_LIMITS.identifierCharacters, 1) ||
        !isBoundedString(subscriptionId, HOST_WIRE_LIMITS.identifierCharacters, 1)
      ) {
        return;
      }
      const grant = repositoryGrants.get(event.sender.id, repositoryId);
      if (!grant) return;
      releaseStatusSubscription(repositoryId, subscriptionId);
    },
  );

  // ── Clone ─────────────────────────────────────────────────────

  registerTrustedIpcHandler(
    'git:clone',
    2,
    async (
      event,
      url: string,
      operationId: string,
    ): Promise<GitResult<ElectronWorkspaceInfo | null>> => {
      const bin = await gitBinOrNull();
      if (!bin) return fail('git-not-available', 'Git is not available');
      if (!isBoundedString(url, HOST_WIRE_LIMITS.urlCharacters, 1) || !isValidCloneUrl(url)) {
        return fail('invalid-url', 'That does not look like a clonable repository URL');
      }
      if (
        !isBoundedString(operationId, HOST_WIRE_LIMITS.identifierCharacters, 1) ||
        cloneOperations.has(operationId) ||
        [...cloneOperations.values()].some((operation) => operation.ownerId === event.sender.id)
      ) {
        return fail('permission-denied', 'Clone operation capability is invalid');
      }

      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const settings = await readSettings();
      const pickerOptions: OpenDialogOptions = {
        title: 'Choose where to clone',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: settings.lastCloneParentDir,
      };
      const picked = win
        ? await dialog.showOpenDialog(win, pickerOptions)
        : await dialog.showOpenDialog(pickerOptions);
      if (picked.canceled || picked.filePaths.length === 0) {
        return { ok: true, value: null };
      }
      let destination: CloneDestination;
      try {
        destination = await CloneDestination.create(picked.filePaths[0], deriveRepoDirName(url));
      } catch (error: unknown) {
        if (error instanceof CloneDestinationExistsError) {
          return fail(
            'destination-exists',
            `${path.basename(error.targetDir)} already exists there`,
          );
        }
        return fail('permission-denied', 'Could not prepare the selected clone destination');
      }
      const parentDir = destination.parentDir;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(bin, ['clone', '--progress', '--', url, destination.stagingDir], {
          cwd: parentDir,
          env: gitEnv(),
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
        });
      } catch {
        await destination.cleanup();
        return fail('unknown', 'Could not start git clone');
      }
      const untrack = trackGitChild(child);
      const operation: CloneOperation = {
        child,
        destination,
        ownerId: event.sender.id,
        cancelled: false,
        timedOut: false,
        untrack,
      };
      cloneOperations.set(operationId, operation);
      registerCloneOwner(event.sender);

      const parseProgress = createCloneProgressParser((progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('git:clone:progress', { operationId, ...progress });
        }
      });
      const cloneTimeout = setTimeout(() => {
        operation.timedOut = true;
        terminateClone(operationId, operation);
      }, CLONE_TIMEOUT_MS);
      cloneTimeout.unref();
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
      clearTimeout(cloneTimeout);
      untrack();
      cloneOperations.delete(operationId);

      if (operation.timedOut) {
        await destination.cleanup();
        return fail('timeout', 'Clone timed out');
      }
      if (operation.cancelled) {
        await destination.cleanup();
        return fail('cancelled', 'Clone cancelled');
      }
      if (code !== 0) {
        await destination.cleanup();
        return { ok: false, error: makeGitError(code, stderr, 'git clone failed') };
      }

      let physicalTargetDir: string;
      try {
        physicalTargetDir = await destination.promote();
      } catch (error: unknown) {
        await destination.cleanup();
        if (error instanceof CloneDestinationExistsError) {
          return fail(
            'destination-exists',
            `${path.basename(error.targetDir)} was created while cloning`,
          );
        }
        return fail('permission-denied', 'Could not publish the cloned repository safely');
      }
      const info = await registerAndPersistWorkspace(physicalTargetDir);
      await updateSettings((s) => ({ ...s, lastCloneParentDir: parentDir }));
      return { ok: true, value: info };
    },
  );

  registerTrustedIpcHandler('git:clone:cancel', 1, async (event, operationId: unknown) => {
    if (!isBoundedString(operationId, HOST_WIRE_LIMITS.identifierCharacters, 1)) return;
    const operation = cloneOperations.get(operationId);
    if (!operation || operation.ownerId !== event.sender.id) return;
    operation.cancelled = true;
    terminateClone(operationId, operation);
  });

  // ── Pull request via gh ───────────────────────────────────────

  registerTrustedIpcHandler(
    'git:createPullRequest',
    1,
    async (event, repositoryId: unknown): Promise<GitResult<void>> => {
      const granted = await getGrantedContext(event, repositoryId);
      if (!granted.ok) return granted as GitResult<void>;
      const gh = await detectGh();
      if (!gh) return fail('gh-not-available', 'GitHub CLI (gh) is not installed');

      const current = await git.status(granted.value.context);
      if (!current.ok) return current as GitResult<void>;
      if (current.value.upstream === null) {
        return fail('no-upstream', 'Publish the branch before creating a pull request');
      }
      if (!current.value.branch) {
        return fail('detached-head', 'Check out a branch before creating a pull request');
      }

      const environment = repositoryToolEnvironment(granted.value.context);
      const viewed = await runTool(
        gh.path,
        ['pr', 'view', '--json', 'url', '--jq', '.url'],
        granted.value.context.workspaceRoot,
        environment,
      );
      const existingUrl = parseExternalHttpUrl(viewed.stdout.trim());
      if (viewed.code === 0 && existingUrl) {
        await shell.openExternal(existingUrl);
        return { ok: true, value: undefined };
      }

      const repository = await runTool(
        gh.path,
        ['repo', 'view', '--json', 'url', '--jq', '.url'],
        granted.value.context.workspaceRoot,
        environment,
      );
      const repositoryUrl = parseExternalHttpUrl(repository.stdout.trim());
      if (repository.code === 0 && repositoryUrl) {
        const createUrl = parseExternalHttpUrl(
          `${repositoryUrl.replace(/\/$/u, '')}/compare/${encodeURIComponent(current.value.branch)}?expand=1`,
        );
        if (createUrl) {
          await shell.openExternal(createUrl);
          return { ok: true, value: undefined };
        }
      }

      const stderr = `${viewed.stderr}\n${repository.stderr}`.trim();
      const code = classifyGhError(stderr);
      return {
        ok: false,
        error: {
          code,
          message:
            code === 'auth-failed'
              ? 'GitHub CLI is not signed in — run `gh auth login`'
              : 'Could not create the pull request',
          stderr: redactGitOutput(stderr).slice(0, 8192) || undefined,
          exitCode: repository.code ?? viewed.code ?? undefined,
        },
      };
    },
  );
}
