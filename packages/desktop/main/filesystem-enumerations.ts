import { randomUUID } from 'node:crypto';
import {
  FsError,
  type FileSystemEnumerationPage,
  type WorkspacePath,
} from '@bendyline/docblocks/filesystem';
import {
  FILE_SYSTEM_ENUMERATION_LIMITS,
  type HostFileSystemEnumerationStep,
} from '@bendyline/docblocks/host';

import type { NodeWorkspaceFileSystemV2 } from './node-workspace-filesystem-v2.js';

interface Session {
  readonly key: string;
  readonly iterator: AsyncIterator<FileSystemEnumerationPage>;
  timer: ReturnType<typeof setTimeout> | null;
  busy: boolean;
}

const EMPTY_PAGE: FileSystemEnumerationPage = Object.freeze({
  entries: Object.freeze([]),
  unreadable: Object.freeze([]),
});

/**
 * Recursive metadata listings a renderer is paging through. Each walk pauses
 * between pages until the renderer asks for the next one, and is closed when
 * the renderer says so, falls idle, or its provider instance goes away.
 */
export class FileSystemEnumerations {
  private readonly sessions = new Map<string, Session>();

  public constructor(
    private readonly limits: {
      readonly sessions: number;
      readonly idleMs: number;
    } = FILE_SYSTEM_ENUMERATION_LIMITS,
  ) {}

  public async begin(
    ownerId: string,
    instanceId: string,
    provider: NodeWorkspaceFileSystemV2,
    itemPath: WorkspacePath,
  ): Promise<HostFileSystemEnumerationStep> {
    const prefix = scope(ownerId, instanceId);
    const open = [...this.sessions.keys()].filter((key) => key.startsWith(prefix)).length;
    if (open >= this.limits.sessions) {
      throw new FsError('busy', 'Too many folder listings are open.', {
        operation: 'list',
        path: itemPath,
      });
    }
    const iterator = provider.enumerate(itemPath)[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) return { cursor: null, page: EMPTY_PAGE };
    const cursor = randomUUID();
    const session: Session = { key: `${prefix}${cursor}`, iterator, timer: null, busy: false };
    this.sessions.set(session.key, session);
    this.arm(session);
    return { cursor, page: first.value };
  }

  public async next(
    ownerId: string,
    instanceId: string,
    cursor: string,
  ): Promise<HostFileSystemEnumerationStep> {
    const session = this.sessions.get(`${scope(ownerId, instanceId)}${cursor}`);
    if (!session) {
      throw new FsError('closed', 'This folder listing is no longer open.', { operation: 'list' });
    }
    if (session.busy) {
      throw new FsError('busy', 'This folder listing is already reading a page.', {
        operation: 'list',
      });
    }
    session.busy = true;
    this.disarm(session);
    try {
      const result = await session.iterator.next();
      if (result.done) {
        this.sessions.delete(session.key);
        return { cursor: null, page: EMPTY_PAGE };
      }
      this.arm(session);
      return { cursor, page: result.value };
    } catch (error: unknown) {
      this.sessions.delete(session.key);
      throw error;
    } finally {
      session.busy = false;
    }
  }

  /** Idempotent: closing a finished or unknown listing does nothing. */
  public async close(ownerId: string, instanceId: string, cursor: string): Promise<void> {
    const session = this.sessions.get(`${scope(ownerId, instanceId)}${cursor}`);
    if (session) await this.end(session);
  }

  /** Close every listing of one provider instance. */
  public async dispose(ownerId: string, instanceId: string): Promise<void> {
    const prefix = scope(ownerId, instanceId);
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.key.startsWith(prefix))
        .map((session) => this.end(session)),
    );
  }

  private async end(session: Session): Promise<void> {
    this.disarm(session);
    this.sessions.delete(session.key);
    try {
      await session.iterator.return?.();
    } catch {
      // A walk that failed while closing has nothing left to release.
    }
  }

  private arm(session: Session): void {
    session.timer = setTimeout(() => void this.end(session), this.limits.idleMs);
    session.timer.unref?.();
  }

  private disarm(session: Session): void {
    if (session.timer !== null) clearTimeout(session.timer);
    session.timer = null;
  }
}

function scope(ownerId: string, instanceId: string): string {
  return `${ownerId}\0${instanceId}\0`;
}
