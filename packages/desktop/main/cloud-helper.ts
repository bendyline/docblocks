/**
 * The Mac app's line to its iCloud helper.
 *
 * DocBlocks on the Mac reaches an iCloud folder as ordinary files. That hides
 * two things only Apple's APIs expose: the versions iCloud sets aside when two
 * devices save the same document, and how far syncing has got. The helper is
 * a small native program (the `CloudHelper` target beside the iPhone storage
 * code, sharing its harvesting) that answers one JSON request per line.
 *
 * It is started on first use and restarted if it exits. In the Mac App Store
 * build it inherits this process's sandbox as it was when the helper started,
 * so a folder the user granted later is invisible to it; a "permission-denied"
 * reply therefore gets one retry with a fresh helper.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CLOUD_HELPER_BINARY_NAME = 'docblocks-cloud-helper';

export interface CloudScan {
  /** False when iCloud does not sync the folder: there is nothing to look for. */
  readonly synced: boolean;
  /** Folder-relative paths of files iCloud holds set-aside versions for. */
  readonly conflicted: readonly string[];
  readonly truncated: boolean;
}

export interface CloudHarvest {
  readonly kept: number;
  readonly duplicates: number;
  /** Versions that could not be copied yet and are still with iCloud. */
  readonly pending: number;
}

export type CloudDownloadState = 'current' | 'stale' | 'not-downloaded' | 'unknown';

export type CloudItemStatus =
  | { readonly path: string; readonly synced: false }
  | {
      readonly path: string;
      readonly synced: true;
      readonly uploaded: boolean;
      readonly uploading: boolean;
      readonly download: CloudDownloadState;
      readonly conflicts: boolean;
    };

export class CloudHelperError extends Error {
  public constructor(
    public readonly code: string,
    message = `The iCloud helper could not complete the request (${code}).`,
  ) {
    super(message);
    this.name = 'CloudHelperError';
  }
}

/** The part of a child process the client uses; tests supply their own. */
export interface CloudHelperProcess {
  write(line: string): void;
  onLine(listener: (line: string) => void): void;
  onExit(listener: () => void): void;
  kill(): void;
}

export type CloudHelperLauncher = (binaryPath: string) => CloudHelperProcess;

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const MAX_BUFFERED_REPLY = 8 * 1024 * 1024;

export const launchCloudHelper: CloudHelperLauncher = (binaryPath) => {
  const child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buffered = '';
  const lineListeners: Array<(line: string) => void> = [];
  const exitListeners: Array<() => void> = [];
  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener();
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    if (buffered.length > MAX_BUFFERED_REPLY) {
      child.kill();
      return;
    }
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      for (const listener of lineListeners) listener(line);
      newline = buffered.indexOf('\n');
    }
  });
  child.on('error', exit);
  child.on('exit', exit);
  // A helper that died leaves a closed pipe; the exit handler reports it.
  child.stdin.on('error', () => undefined);
  return {
    write: (line) => {
      child.stdin.write(`${line}\n`);
    },
    onLine: (listener) => {
      lineListeners.push(listener);
    },
    onExit: (listener) => {
      exitListeners.push(listener);
    },
    kill: () => {
      child.kill();
    },
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CloudHelperError('corrupt');
  }
  return value;
}

function parseScan(value: unknown): CloudScan {
  if (
    !isRecord(value) ||
    typeof value.synced !== 'boolean' ||
    typeof value.truncated !== 'boolean' ||
    !Array.isArray(value.conflicted) ||
    !value.conflicted.every((item) => typeof item === 'string' && item.length > 0)
  ) {
    throw new CloudHelperError('corrupt');
  }
  return {
    synced: value.synced,
    truncated: value.truncated,
    conflicted: value.conflicted as string[],
  };
}

function parseHarvest(value: unknown): CloudHarvest {
  if (!isRecord(value)) throw new CloudHelperError('corrupt');
  return {
    kept: count(value.kept),
    duplicates: count(value.duplicates),
    pending: count(value.pending),
  };
}

const DOWNLOAD_STATES: readonly string[] = ['current', 'stale', 'not-downloaded', 'unknown'];

function parseStatus(value: unknown): CloudItemStatus[] {
  if (!Array.isArray(value)) throw new CloudHelperError('corrupt');
  return value.map((item): CloudItemStatus => {
    if (!isRecord(item) || typeof item.path !== 'string' || typeof item.synced !== 'boolean') {
      throw new CloudHelperError('corrupt');
    }
    if (!item.synced) return { path: item.path, synced: false };
    if (
      typeof item.uploaded !== 'boolean' ||
      typeof item.uploading !== 'boolean' ||
      typeof item.conflicts !== 'boolean' ||
      typeof item.download !== 'string' ||
      !DOWNLOAD_STATES.includes(item.download)
    ) {
      throw new CloudHelperError('corrupt');
    }
    return {
      path: item.path,
      synced: true,
      uploaded: item.uploaded,
      uploading: item.uploading,
      conflicts: item.conflicts,
      download: item.download as CloudDownloadState,
    };
  });
}

export class CloudHelper {
  private process: CloudHelperProcess | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private disposed = false;

  public constructor(
    private readonly binaryPath: string,
    private readonly launch: CloudHelperLauncher = launchCloudHelper,
    private readonly timeoutMs = 30_000,
  ) {}

  public async scan(root: string): Promise<CloudScan> {
    return parseScan(await this.request({ op: 'scan', root }));
  }

  public async harvest(root: string, relativePath: string): Promise<CloudHarvest> {
    return parseHarvest(await this.request({ op: 'harvest', root, path: relativePath }));
  }

  public async status(paths: readonly string[]): Promise<CloudItemStatus[]> {
    return parseStatus(await this.request({ op: 'status', paths }));
  }

  public dispose(): void {
    this.disposed = true;
    this.stop(new CloudHelperError('closed', 'The iCloud helper was closed.'));
  }

  private async request(body: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.send(body);
    } catch (error: unknown) {
      // The helper may predate a folder grant; a fresh one inherits it.
      if (!(error instanceof CloudHelperError) || error.code !== 'permission-denied') throw error;
      this.stop(new CloudHelperError('closed', 'The iCloud helper was restarted.'));
      return this.send(body);
    }
  }

  private send(body: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new CloudHelperError('closed', 'The iCloud helper was closed.'));
    }
    let child: CloudHelperProcess;
    try {
      child = this.start();
    } catch {
      return Promise.reject(new CloudHelperError('unavailable'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // An unanswered request means the helper is stuck; replies after it would be misread.
        this.stop(new CloudHelperError('timeout'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.write(JSON.stringify({ ...body, id }));
      } catch {
        this.stop(new CloudHelperError('unavailable'));
      }
    });
  }

  private start(): CloudHelperProcess {
    if (this.process) return this.process;
    const child = this.launch(this.binaryPath);
    this.process = child;
    child.onLine((line) => this.receive(child, line));
    child.onExit(() => {
      if (this.process !== child) return;
      this.process = null;
      this.rejectAll(new CloudHelperError('unavailable'));
    });
    return child;
  }

  private receive(child: CloudHelperProcess, line: string): void {
    if (this.process !== child) return;
    let reply: unknown;
    try {
      reply = JSON.parse(line);
    } catch {
      this.stop(new CloudHelperError('corrupt'));
      return;
    }
    if (!isRecord(reply) || typeof reply.id !== 'number') return;
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    clearTimeout(pending.timer);
    if (reply.ok === true) pending.resolve(reply.value);
    else pending.reject(new CloudHelperError(typeof reply.code === 'string' ? reply.code : 'io'));
  }

  private stop(reason: Error): void {
    const child = this.process;
    this.process = null;
    this.rejectAll(reason);
    child?.kill();
  }

  private rejectAll(reason: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
  }
}

export interface CloudHelperLocation {
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  /** Electron's `process.resourcesPath`. */
  readonly resourcesPath: string;
  /** Electron's `app.getAppPath()`. */
  readonly appPath: string;
  /** macOS version, as `process.getSystemVersion()` reports it. */
  readonly systemVersion?: string;
  readonly exists?: (candidate: string) => boolean;
}

/** The helper is built for the Swift package's macOS floor. */
const MINIMUM_MACOS_MAJOR = 13;

/**
 * Where the helper lives, or null when this build has none (every platform
 * but macOS, and a source checkout that has not staged it). Callers treat
 * null as "iCloud extras are off", never as an error.
 */
export function resolveCloudHelperBinary(location: CloudHelperLocation): string | null {
  if (location.platform !== 'darwin') return null;
  // The editor runs on older macOS than the helper does; there it simply goes without.
  if (location.systemVersion !== undefined) {
    const major = Number.parseInt(location.systemVersion, 10);
    if (!Number.isFinite(major) || major < MINIMUM_MACOS_MAJOR) return null;
  }
  const exists = location.exists ?? ((candidate: string) => fs.existsSync(candidate));
  const candidate = location.packaged
    ? // Contents/Resources -> Contents/Helpers, where macOS expects nested programs.
      path.join(location.resourcesPath, '..', 'Helpers', CLOUD_HELPER_BINARY_NAME)
    : path.join(location.appPath, 'dist', 'cloud-helper', CLOUD_HELPER_BINARY_NAME);
  return exists(candidate) ? candidate : null;
}
