/**
 * IPC handlers for filesystem operations.
 *
 * Every handler takes a `rootPath` string (the workspace's absolute root)
 * and a path relative to that root. The WorkspaceRoots whitelist validates
 * both lexical traversal and the physical target of symlink/junction
 * ancestors before native filesystem operations run.
 */

import type { WebContents } from 'electron';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import {
  parseWorkspacePath,
  workspacePathToLegacy,
  type FileCommitResult,
  type FileSystemEntry,
  type FileMeta,
} from '@bendyline/docblocks/filesystem';
import { HOST_WIRE_LIMITS, isBoundedBytePayload, isBoundedString } from '@bendyline/docblocks/host';

import { getWorkspaceRoots } from './workspace-roots.js';
import { acquireWorkspaceWatcher, type WorkspaceWatcherHandle } from './workspace-watchers.js';
import {
  atomicWriteBinary,
  atomicWriteText,
  commitTextFile,
  withFileMutationLocks,
} from './file-commit.js';
import { statFileThroughDescriptor } from './file-stat.js';
import { deleteWorkspaceEntry } from './workspace-file-operations.js';
import { registerTrustedIpcHandler } from './ipc-authority.js';
import { bindOwnerGrantRevocation } from './owner-revocation.js';
import type { WorkspaceRoots } from './workspace-roots.js';

function workspaceRoot(roots: WorkspaceRoots, value: unknown): string {
  if (!isBoundedString(value, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
    throw new Error('Invalid workspace capability');
  }
  const workspace = roots.get(value);
  if (!workspace) throw new Error('Workspace capability is not registered');
  return workspace.rootPath;
}

function workspacePath(value: unknown): string {
  if (!isBoundedString(value, HOST_WIRE_LIMITS.pathCharacters)) {
    throw new Error('Invalid workspace path');
  }
  return workspacePathToLegacy(parseWorkspacePath(value));
}

function textPayload(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (!isBoundedString(value, HOST_WIRE_LIMITS.documentCharacters)) {
    throw new Error('Text payload exceeds the host message limit');
  }
  return value;
}

async function readBoundedWorkspaceFile(
  roots: WorkspaceRoots,
  rootPath: string,
  itemPath: string,
  maximumBytes: number,
): Promise<Buffer | null> {
  const absolutePath = await roots.resolvePhysical(rootPath, itemPath);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(absolutePath, 'r');
  } catch (error: unknown) {
    if (isMissingPath(error)) return null;
    throw error;
  }

  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) {
      throw new Error('File exceeds the host message size limit');
    }
    await assertWorkspaceDescriptorIdentity(roots, rootPath, itemPath, before);
    const result = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < result.length) {
      const { bytesRead } = await handle.read(result, offset, result.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead > 0) {
      throw new Error('File changed beyond the host message size limit');
    }
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error('File changed while it was being read');
    }
    await assertWorkspaceDescriptorIdentity(roots, rootPath, itemPath, after);
    return result.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function assertWorkspaceDescriptorIdentity(
  roots: WorkspaceRoots,
  rootPath: string,
  itemPath: string,
  descriptorStat: Awaited<ReturnType<fs.FileHandle['stat']>>,
): Promise<void> {
  const validatedPath = await roots.resolvePhysical(rootPath, itemPath);
  const pathStat = await statFileThroughDescriptor(validatedPath);
  if (descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) {
    throw new Error('Workspace resource changed physical identity while it was being read');
  }
}

function toRelative(absolutePath: string, rootAbs: string): string {
  const rel = path.relative(rootAbs, absolutePath).replace(/\\/g, '/');
  return rel;
}

async function listEntries(absDir: string): Promise<FileSystemEntry[]> {
  const rootAbs = path.resolve(absDir);
  let raw: fss.Dirent[];
  try {
    raw = await fs.readdir(rootAbs, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries: FileSystemEntry[] = raw
    .filter((d) => !d.name.startsWith('.DS_Store') && (d.isDirectory() || d.isFile()))
    .map((d) => {
      const full = path.join(rootAbs, d.name);
      return d.isDirectory()
        ? { kind: 'directory' as const, name: d.name, path: full }
        : { kind: 'file' as const, name: d.name, path: full };
    });
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function registerFsIpc(): void {
  const roots = getWorkspaceRoots();

  registerTrustedIpcHandler('fs:readFile', 2, async (_event, workspaceId: unknown, p: unknown) => {
    const rootPath = workspaceRoot(roots, workspaceId);
    const parsedPath = workspacePath(p);
    const bytes = await readBoundedWorkspaceFile(
      roots,
      rootPath,
      parsedPath,
      HOST_WIRE_LIMITS.documentCharacters,
    );
    return bytes?.toString('utf8') ?? null;
  });

  registerTrustedIpcHandler(
    'fs:writeFile',
    3,
    async (_event, workspaceId: unknown, p: unknown, content: unknown) => {
      const rootPath = workspaceRoot(roots, workspaceId);
      p = workspacePath(p);
      content = textPayload(content);
      const rootAbs = roots.resolve(rootPath, '');
      const lexicalTarget = roots.resolve(rootPath, p as string);
      await withFileMutationLocks([rootAbs, lexicalTarget], async () => {
        const abs = await roots.resolveMutation(rootPath, p as string);
        await atomicWriteText(abs, content as string);
      });
    },
  );

  registerTrustedIpcHandler(
    'fs:commitFile',
    4,
    async (
      _event,
      workspaceId: unknown,
      p: unknown,
      content: unknown,
      expectedContent: unknown,
    ): Promise<FileCommitResult> => {
      const rootPath = workspaceRoot(roots, workspaceId);
      const parsedPath = workspacePath(p);
      const parsedContent = textPayload(content) as string;
      const parsedExpected = textPayload(expectedContent, true);
      const rootAbs = roots.resolve(rootPath, '');
      const lexicalTarget = roots.resolve(rootPath, parsedPath);
      return commitTextFile(
        () => roots.resolveMutation(rootPath, parsedPath),
        parsedContent,
        parsedExpected,
        [rootAbs, lexicalTarget],
      );
    },
  );

  registerTrustedIpcHandler('fs:delete', 2, async (_event, workspaceId: unknown, p: unknown) => {
    await deleteWorkspaceEntry(roots, workspaceRoot(roots, workspaceId), workspacePath(p));
  });

  registerTrustedIpcHandler(
    'fs:rename',
    3,
    async (_event, workspaceId: unknown, oldValue: unknown, newValue: unknown) => {
      const rootPath = workspaceRoot(roots, workspaceId);
      const oldP = workspacePath(oldValue);
      const newP = workspacePath(newValue);
      const rootAbs = roots.resolve(rootPath, '');
      const oldLexical = roots.resolve(rootPath, oldP);
      const newLexical = roots.resolve(rootPath, newP);
      await withFileMutationLocks([rootAbs, oldLexical, newLexical], async () => {
        const oldAbs = await roots.resolveMutation(rootPath, oldP);
        const newAbs = await roots.resolveMutation(rootPath, newP);
        try {
          await fs.access(newAbs);
          throw new Error(`Destination exists: ${newP}`);
        } catch (error: unknown) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') throw error;
        }
        await fs.mkdir(path.dirname(newAbs), { recursive: true });
        await fs.rename(oldAbs, newAbs);
      });
    },
  );

  registerTrustedIpcHandler(
    'fs:readDirectory',
    2,
    async (_event, workspaceId: unknown, value: unknown): Promise<FileSystemEntry[]> => {
      const rootPath = workspaceRoot(roots, workspaceId);
      const p = workspacePath(value);
      const abs = await roots.resolvePhysical(rootPath, p);
      const rootAbs = await roots.resolvePhysical(rootPath, '');
      const before = await fs.stat(abs);
      const entries = await listEntries(abs);
      const validatedAfter = await roots.resolvePhysical(rootPath, p);
      const after = await fs.stat(validatedAfter);
      if (before.dev !== after.dev || before.ino !== after.ino) {
        throw new Error('Directory changed physical identity while it was being read');
      }
      if (entries.length > HOST_WIRE_LIMITS.arrayEntries) {
        throw new Error('Directory exceeds the host entry limit');
      }
      // Convert absolute paths to paths relative to the workspace root (with
      // a leading slash to match the browser providers' convention).
      return entries.map((e) => ({
        ...e,
        path: '/' + toRelative(e.path, rootAbs),
      }));
    },
  );

  registerTrustedIpcHandler(
    'fs:exists',
    2,
    async (_event, workspaceId: unknown, value: unknown) => {
      const rootPath = workspaceRoot(roots, workspaceId);
      const p = workspacePath(value);
      const abs = await roots.resolvePhysical(rootPath, p);
      try {
        await fs.access(abs);
        await roots.resolvePhysical(rootPath, p);
        return true;
      } catch (error: unknown) {
        if (isMissingPath(error)) return false;
        throw error;
      }
    },
  );

  registerTrustedIpcHandler(
    'fs:createDirectory',
    2,
    async (_event, workspaceId: unknown, value: unknown) => {
      const rootPath = workspaceRoot(roots, workspaceId);
      const p = workspacePath(value);
      const rootAbs = roots.resolve(rootPath, '');
      const lexicalTarget = roots.resolve(rootPath, p);
      await withFileMutationLocks([rootAbs, lexicalTarget], async () => {
        const abs = await roots.resolveMutation(rootPath, p);
        await fs.mkdir(abs, { recursive: true });
      });
    },
  );

  registerTrustedIpcHandler(
    'fs:stat',
    2,
    async (_event, workspaceId: unknown, value: unknown): Promise<FileMeta | null> => {
      const rootPath = workspaceRoot(roots, workspaceId);
      const p = workspacePath(value);
      const abs = await roots.resolvePhysical(rootPath, p);
      try {
        const st = await fs.stat(abs);
        if (!st.isFile()) return null;
        const validatedAfter = await roots.resolvePhysical(rootPath, p);
        const after = await fs.stat(validatedAfter);
        if (st.dev !== after.dev || st.ino !== after.ino) {
          throw new Error('File changed physical identity while it was being inspected');
        }
        return {
          name: path.basename(abs),
          path: p.replace(/^\/+/, ''),
          size: st.size,
          lastModified: st.mtime.toISOString(),
        };
      } catch (error: unknown) {
        if (isMissingPath(error)) return null;
        throw error;
      }
    },
  );

  registerTrustedIpcHandler(
    'fs:readBinary',
    2,
    async (_event, workspaceId: unknown, value: unknown): Promise<ArrayBuffer | null> => {
      const rootPath = workspaceRoot(roots, workspaceId);
      const p = workspacePath(value);
      try {
        const buf = await readBoundedWorkspaceFile(
          roots,
          rootPath,
          p,
          HOST_WIRE_LIMITS.binaryBytes,
        );
        if (!buf) return null;
        // Slice to produce a fresh ArrayBuffer (avoid sharing the Node Buffer's pool).
        // Cast: readFile returns Buffer whose .buffer is ArrayBufferLike in TS 5.9.
        const arr = new Uint8Array(buf.byteLength);
        arr.set(buf);
        return arr.buffer;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') return null;
        throw err;
      }
    },
  );

  registerTrustedIpcHandler(
    'fs:writeBinary',
    3,
    async (_event, workspaceId: unknown, value: unknown, data: unknown) => {
      const rootPath = workspaceRoot(roots, workspaceId);
      const p = workspacePath(value);
      if (!isBoundedBytePayload(data)) throw new Error('Binary payload exceeds the host limit');
      const rootAbs = roots.resolve(rootPath, '');
      const lexicalTarget = roots.resolve(rootPath, p);
      await withFileMutationLocks([rootAbs, lexicalTarget], async () => {
        const abs = await roots.resolveMutation(rootPath, p);
        await atomicWriteBinary(abs, data);
      });
    },
  );

  // ── Watch support ──────────────────────────────────────────────
  // One shared watcher per workspace root (see workspace-watchers.ts); one
  // subscription id per renderer watch() call. When the last subscription
  // for a root unsubscribes, this consumer's acquisition is released.
  interface WatchSubscription {
    subscriptionId: string;
    sender: WebContents;
    onDestroyed: () => void;
  }

  interface WatchState {
    handle: WorkspaceWatcherHandle;
    subscriptions: Map<string, WatchSubscription>;
  }
  const watchersByRoot = new Map<string, WatchState>();
  const subscriptions = new Map<string, { rootKey: string; subscription: WatchSubscription }>();
  const boundWatchOwners = new Set<number>();

  const releaseSubscription = (token: string, removeDestroyedListener: boolean): void => {
    const registered = subscriptions.get(token);
    if (!registered) return;
    subscriptions.delete(token);

    const { rootKey, subscription } = registered;
    if (removeDestroyedListener && !subscription.sender.isDestroyed()) {
      subscription.sender.removeListener('destroyed', subscription.onDestroyed);
    }

    const state = watchersByRoot.get(rootKey);
    if (!state) return;
    state.subscriptions.delete(token);
    if (state.subscriptions.size === 0) {
      state.handle.release();
      watchersByRoot.delete(rootKey);
    }
  };

  registerTrustedIpcHandler(
    'fs:watch:subscribe',
    2,
    async (event, workspaceId: unknown, subscriptionValue: unknown) => {
      const rootPath = workspaceRoot(roots, workspaceId);
      if (!isBoundedString(subscriptionValue, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
        throw new Error('Invalid filesystem watch subscription');
      }
      const subscriptionId = subscriptionValue;
      const rootAbs = await roots.resolvePhysical(rootPath, '');
      const key = await fs.realpath(rootAbs);
      const token = `${event.sender.id}:${subscriptionId}`;
      if (subscriptions.has(token)) throw new Error('Duplicate filesystem watch subscription.');

      let state = watchersByRoot.get(key);
      if (!state) {
        const handle = acquireWorkspaceWatcher(key);
        const created: WatchState = { handle, subscriptions: new Map() };
        handle.onChange((rel) => {
          for (const subscription of created.subscriptions.values()) {
            if (!subscription.sender.isDestroyed()) {
              subscription.sender.send('fs:watch:event', {
                subscriptionId: subscription.subscriptionId,
                path: rel,
              });
            }
          }
        });
        watchersByRoot.set(key, created);
        state = created;
      }

      const onDestroyed = () => releaseSubscription(token, false);
      const subscription: WatchSubscription = {
        subscriptionId,
        sender: event.sender,
        onDestroyed,
      };
      state.subscriptions.set(token, subscription);
      subscriptions.set(token, { rootKey: key, subscription });
      event.sender.once('destroyed', onDestroyed);
      if (!boundWatchOwners.has(event.sender.id)) {
        boundWatchOwners.add(event.sender.id);
        bindOwnerGrantRevocation(event.sender, () => {
          for (const currentToken of [...subscriptions.keys()]) {
            if (currentToken.startsWith(`${event.sender.id}:`)) {
              releaseSubscription(currentToken, false);
            }
          }
        });
        event.sender.once('destroyed', () => boundWatchOwners.delete(event.sender.id));
      }
    },
  );

  registerTrustedIpcHandler(
    'fs:watch:unsubscribe',
    2,
    async (event, workspaceId: unknown, subscriptionValue: unknown) => {
      workspaceRoot(roots, workspaceId);
      if (!isBoundedString(subscriptionValue, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
        throw new Error('Invalid filesystem watch subscription');
      }
      const subscriptionId = subscriptionValue;
      releaseSubscription(`${event.sender.id}:${subscriptionId}`, true);
    },
  );
}
