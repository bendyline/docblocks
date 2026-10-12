/**
 * Keeps a workspace's catalog outputs (`index.html`, `catalog.json`) current.
 *
 * One scheduler serves one workspace. Document commits and file-tree changes
 * call `notify(path)`; the scheduler debounces them (with a maximum wait so a
 * long typing session still refreshes), runs one refresh at a time, and
 * re-runs once when changes arrived mid-run. Its own output writes, version
 * snapshots, and other hidden bookkeeping never trigger a run. Disposing it
 * (workspace switch) cancels any in-flight walk.
 */

import { FsError } from '../filesystem/fs-error.js';
import {
  createWorkspaceCatalogCache,
  isCatalogRelevantPath,
  refreshWorkspaceOutputs,
  WorkspaceOutputsLimitError,
  type WorkspaceOutputResult,
  type WorkspaceOutputsIO,
  type WorkspaceOutputsRenderer,
  type WorkspaceOutputsResult,
} from './outputs.js';
import { resolveCatalogOutputs, type WorkspaceSettings } from './settings.js';

export interface WorkspaceOutputsStatus {
  readonly state: 'idle' | 'pending' | 'running' | 'done' | 'error';
  readonly result: WorkspaceOutputsResult | null;
  /** A run failure, or the first blocked output's explanation. */
  readonly message: string | null;
}

export const IDLE_WORKSPACE_OUTPUTS_STATUS: WorkspaceOutputsStatus = Object.freeze({
  state: 'idle',
  result: null,
  message: null,
});

export interface WorkspaceOutputsScheduler {
  readonly workspaceId: string;
  /** A document or folder changed. Paths that cannot affect the catalog are ignored. */
  notify(path?: string): void;
  /** Run now if a refresh is pending. */
  flush(): void;
  /** Run now regardless of pending changes. */
  regenerate(options?: { readonly force?: boolean }): Promise<WorkspaceOutputsStatus>;
  updateSettings(settings: WorkspaceSettings | null): void;
  getStatus(): WorkspaceOutputsStatus;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface WorkspaceOutputsSchedulerOptions {
  readonly workspaceId: string;
  readonly provider: WorkspaceOutputsIO;
  readonly settings: WorkspaceSettings | null;
  /** The renderer, or a loader so rendering code loads only once a catalog is enabled. */
  readonly renderer: WorkspaceOutputsRenderer | (() => Promise<WorkspaceOutputsRenderer>);
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
}

export const WORKSPACE_OUTPUTS_DEBOUNCE_MS = 2_500;
export const WORKSPACE_OUTPUTS_MAX_WAIT_MS = 20_000;

function outputsSignature(settings: WorkspaceSettings | null): string {
  try {
    return JSON.stringify(resolveCatalogOutputs(settings));
  } catch {
    return 'invalid';
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof WorkspaceOutputsLimitError) return error.message;
  if (error instanceof FsError) return `Couldn't update the catalog: ${error.message}`;
  return `Couldn't update the catalog: ${error instanceof Error ? error.message : String(error)}`;
}

function firstBlocked(result: WorkspaceOutputsResult): WorkspaceOutputResult | undefined {
  return result.outputs.find((output) => output.status === 'blocked');
}

export function createWorkspaceOutputsScheduler(
  options: WorkspaceOutputsSchedulerOptions,
): WorkspaceOutputsScheduler {
  const debounceMs = options.debounceMs ?? WORKSPACE_OUTPUTS_DEBOUNCE_MS;
  const maxWaitMs = options.maxWaitMs ?? WORKSPACE_OUTPUTS_MAX_WAIT_MS;
  const cache = createWorkspaceCatalogCache();
  const listeners = new Set<() => void>();
  let settings = options.settings;
  let signature = outputsSignature(settings);
  let status = IDLE_WORKSPACE_OUTPUTS_STATUS;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<WorkspaceOutputsStatus> | null = null;
  let controller: AbortController | null = null;
  let dirty = false;
  let forceNext = false;
  let disposed = false;

  const setStatus = (next: WorkspaceOutputsStatus) => {
    status = next;
    for (const listener of [...listeners]) listener();
  };

  const clearTimers = () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    if (maxWaitTimer !== null) clearTimeout(maxWaitTimer);
    debounceTimer = null;
    maxWaitTimer = null;
  };

  const enabled = () => resolveCatalogOutputsSafe(settings) !== null;

  const run = (): Promise<WorkspaceOutputsStatus> => {
    clearTimers();
    if (disposed || !enabled()) {
      dirty = false;
      return Promise.resolve(status);
    }
    if (running) {
      dirty = true;
      return running;
    }
    dirty = false;
    const force = forceNext;
    forceNext = false;
    const runSettings = settings;
    controller = new AbortController();
    const signal = controller.signal;
    setStatus({ ...status, state: 'running' });

    running = (async (): Promise<WorkspaceOutputsStatus> => {
      try {
        const renderer =
          typeof options.renderer === 'function' ? await options.renderer() : options.renderer;
        let result: WorkspaceOutputsResult;
        try {
          result = await refreshWorkspaceOutputs(options.provider, runSettings, renderer, {
            cache,
            signal,
            force,
          });
        } catch (error) {
          // Another writer (window, git, sync) won a race: walk once more.
          if (!(error instanceof FsError && error.code === 'conflict')) throw error;
          result = await refreshWorkspaceOutputs(options.provider, runSettings, renderer, {
            cache,
            signal,
            force,
          });
        }
        const blocked = firstBlocked(result);
        return { state: 'done', result, message: blocked?.message ?? null };
      } catch (error) {
        if (error instanceof FsError && error.code === 'aborted') {
          return status.state === 'running' ? { ...status, state: 'idle' } : status;
        }
        return { state: 'error', result: null, message: describeFailure(error) };
      }
    })().then((next) => {
      running = null;
      controller = null;
      if (!disposed) {
        setStatus(next);
        if (dirty) schedule();
      }
      return next;
    });
    return running;
  };

  const schedule = () => {
    if (disposed || !enabled()) return;
    if (status.state !== 'running') setStatus({ ...status, state: 'pending' });
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void run(), debounceMs);
    maxWaitTimer ??= setTimeout(() => void run(), maxWaitMs);
  };

  const scheduler: WorkspaceOutputsScheduler = {
    workspaceId: options.workspaceId,
    notify(path) {
      if (disposed) return;
      if (path !== undefined && !isCatalogRelevantPath(path, settings)) return;
      if (running) {
        dirty = true;
        return;
      }
      schedule();
    },
    flush() {
      if (debounceTimer !== null || maxWaitTimer !== null) void run();
    },
    regenerate(regenerateOptions) {
      if (regenerateOptions?.force) forceNext = true;
      if (running) dirty = true;
      return running ?? run();
    },
    updateSettings(next) {
      settings = next;
      const nextSignature = outputsSignature(next);
      if (nextSignature === signature) return;
      signature = nextSignature;
      if (!enabled()) {
        clearTimers();
        controller?.abort();
        setStatus(IDLE_WORKSPACE_OUTPUTS_STATUS);
        return;
      }
      scheduler.notify();
    },
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      clearTimers();
      controller?.abort();
      listeners.clear();
    },
  };

  // A newly opened workspace catches up on edits made elsewhere (another
  // app, a git pull). Unchanged outputs are detected without writing.
  if (enabled()) scheduler.notify();
  return scheduler;
}

function resolveCatalogOutputsSafe(settings: WorkspaceSettings | null) {
  try {
    return resolveCatalogOutputs(settings);
  } catch {
    return null;
  }
}
