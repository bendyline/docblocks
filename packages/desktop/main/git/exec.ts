/**
 * Git process runner — the single place a `git` child process is spawned.
 *
 * Never uses a shell; argv is always a fixed array built by commands.ts.
 * The environment inherits the user's credential helpers and SSH agent but
 * disables every interactive prompt so a missing credential fails fast with
 * classifiable stderr instead of hanging a child forever.
 */

import { spawn, type ChildProcess } from 'node:child_process';

export interface RunGitOptions {
  /** Absolute path to the git binary (from detect.ts). */
  bin: string;
  /** Working directory — a validated workspace root (or clone parent dir). */
  cwd: string;
  args: string[];
  /** Kill the child after this long. Default 30s; use NETWORK_TIMEOUT_MS for remote ops. */
  timeoutMs?: number;
  /** Abort if stdout exceeds this many bytes. Default 20 MB. */
  maxStdoutBytes?: number;
}

export interface RunGitResult {
  /** Exit code; null when the child was killed or failed to spawn. */
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

export const LOCAL_TIMEOUT_MS = 30_000;
export const NETWORK_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_STDOUT = 20 * 1024 * 1024;
const MAX_STDERR = 1024 * 1024;
const KILL_GRACE_MS = 5_000;

/** Env for every git/gh child: inherit credentials, forbid interactivity. */
export function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Fail fast instead of prompting on stdin for credentials.
    GIT_TERMINAL_PROMPT: '0',
    // Git Credential Manager: never show interactive UI from our child.
    GCM_INTERACTIVE: 'never',
    // Status/reads never take the index lock (avoids racing user tooling).
    GIT_OPTIONAL_LOCKS: '0',
    // Stable English stderr so classifyGitError patterns match.
    LC_ALL: 'C',
  };
}

const liveChildren = new Set<ChildProcess>();

/** Kill every in-flight git child. Called from the app's before-quit hook. */
export function killAllGitChildren(): void {
  for (const child of liveChildren) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already dead
    }
  }
  liveChildren.clear();
}

/** Track an externally spawned child (clone) in the kill-on-quit registry. */
export function trackGitChild(child: ChildProcess): () => void {
  liveChildren.add(child);
  return () => liveChildren.delete(child);
}

export function runGit(opts: RunGitOptions): Promise<RunGitResult> {
  const timeoutMs = opts.timeoutMs ?? LOCAL_TIMEOUT_MS;
  const maxStdout = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;

  return new Promise<RunGitResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(opts.bin, opts.args, {
        cwd: opts.cwd,
        env: gitEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolve({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: 'failed to spawn git',
        timedOut: false,
      });
      return;
    }

    liveChildren.add(child);
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, KILL_GRACE_MS).unref();
    }, timeoutMs);
    timer.unref();

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveChildren.delete(child);
      resolve({ code, stdout: Buffer.concat(stdoutChunks), stderr, timedOut });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        stderr += '\ngit output exceeded the size limit';
        timedOut = false;
        child.kill('SIGKILL');
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) {
        stderr += chunk.toString('utf8');
      }
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

const repoLocks = new Map<string, Promise<unknown>>();

/**
 * Serialize mutating operations per repository toplevel; reads run freely.
 * The stored chain never rejects — each link swallows its predecessor's error.
 */
export async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  repoLocks.set(key, tail);
  try {
    return await run;
  } finally {
    // Drop the map entry once nothing newer has chained onto it.
    if (repoLocks.get(key) === tail) repoLocks.delete(key);
  }
}
