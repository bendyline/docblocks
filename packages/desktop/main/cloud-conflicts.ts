/**
 * Decides when the Mac app asks its iCloud helper to look for versions iCloud
 * set aside, and to move them into the document's sidecar.
 *
 * Nothing here reports to the renderer. A harvested copy lands in
 * `<name>_files/conflicts/`, a folder the workspace watcher already covers,
 * so the open window learns of it the way it learns of any other change.
 * Every step is best effort: a helper that is missing, slow, or denied leaves
 * the versions with iCloud for the next attempt.
 */

import {
  CloudHelper,
  resolveCloudHelperBinary,
  type CloudHarvest,
  type CloudHelperLocation,
  type CloudScan,
} from './cloud-helper.js';
import type { FileSystemV2Observer } from './filesystem-v2-ipc-service.js';

export interface CloudConflictClient {
  scan(root: string): Promise<CloudScan>;
  harvest(root: string, relativePath: string): Promise<CloudHarvest>;
  dispose(): void;
}

export interface CloudConflictOptions {
  /** How long a document's changes settle before its versions are collected. */
  readonly harvestDelayMs?: number;
  /** The least time between two looks through one folder. */
  readonly scanIntervalMs?: number;
  readonly now?: () => number;
}

interface RootState {
  references: number;
  /** Null until the first scan says whether iCloud syncs this folder. */
  synced: boolean | null;
  lastScanAt: number;
  scanning: boolean;
  readonly timers: Map<string, ReturnType<typeof setTimeout>>;
}

const DEFAULT_HARVEST_DELAY_MS = 750;
const DEFAULT_SCAN_INTERVAL_MS = 60_000;

/** Copies are final; iCloud's own bookkeeping and tool folders are not documents. */
function isHarvestable(relativePath: string): boolean {
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment.startsWith('.'))) return false;
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index]!.endsWith('_files') && segments[index + 1] === 'conflicts') return false;
  }
  return true;
}

export class CloudConflictCoordinator {
  private readonly roots = new Map<string, RootState>();
  private readonly harvestDelayMs: number;
  private readonly scanIntervalMs: number;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  public constructor(
    private readonly client: CloudConflictClient,
    options: CloudConflictOptions = {},
  ) {
    this.harvestDelayMs = options.harvestDelayMs ?? DEFAULT_HARVEST_DELAY_MS;
    this.scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  /** A window opened this folder. Paired with `workspaceClosed`. */
  public workspaceOpened(root: string): void {
    if (this.disposed) return;
    const state = this.roots.get(root);
    if (state) {
      state.references += 1;
      return;
    }
    this.roots.set(root, {
      references: 1,
      synced: null,
      lastScanAt: Number.NEGATIVE_INFINITY,
      scanning: false,
      timers: new Map(),
    });
    this.scan(root);
  }

  public workspaceClosed(root: string): void {
    const state = this.roots.get(root);
    if (!state) return;
    state.references -= 1;
    if (state.references > 0) return;
    for (const timer of state.timers.values()) clearTimeout(timer);
    this.roots.delete(root);
  }

  /** A document was read or changed on disk; its set-aside versions may be new. */
  public documentTouched(root: string, relativePath: string): void {
    const state = this.roots.get(root);
    const clean = relativePath.replace(/^\/+/, '');
    if (this.disposed || !state || state.synced === false || !clean || !isHarvestable(clean)) {
      return;
    }
    const existing = state.timers.get(clean);
    if (existing) clearTimeout(existing);
    state.timers.set(
      clean,
      setTimeout(() => {
        state.timers.delete(clean);
        this.harvest(root, clean);
      }, this.harvestDelayMs),
    );
  }

  /** The app came forward, or time passed: look through every synced folder again. */
  public refresh(): void {
    if (this.disposed) return;
    for (const [root, state] of this.roots) {
      if (state.synced === false) continue;
      if (this.now() - state.lastScanAt < this.scanIntervalMs) continue;
      this.scan(root);
    }
  }

  /** Resolves when everything already asked for has finished. For shutdown and tests. */
  public async idle(): Promise<void> {
    // Finished work can queue more (a scan queues one harvest per file it found).
    let settled: Promise<void> | null = null;
    while (settled !== this.queue) {
      settled = this.queue;
      await settled;
    }
  }

  public dispose(): void {
    this.disposed = true;
    for (const state of this.roots.values()) {
      for (const timer of state.timers.values()) clearTimeout(timer);
    }
    this.roots.clear();
    this.client.dispose();
  }

  private scan(root: string): void {
    const state = this.roots.get(root);
    if (!state || state.scanning) return;
    state.scanning = true;
    state.lastScanAt = this.now();
    this.enqueue(async () => {
      try {
        const current = this.roots.get(root);
        if (!current) return;
        const found = await this.client.scan(root);
        if (this.roots.get(root) !== current) return;
        current.synced = found.synced;
        if (!found.synced) return;
        for (const relativePath of found.conflicted) {
          if (isHarvestable(relativePath)) this.harvest(root, relativePath);
        }
      } finally {
        state.scanning = false;
      }
    });
  }

  private harvest(root: string, relativePath: string): void {
    this.enqueue(async () => {
      // A touch can arrive before the first scan has said whether iCloud syncs the folder.
      if (this.roots.get(root)?.synced !== true) return;
      await this.client.harvest(root, relativePath);
    });
  }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      if (this.disposed) return;
      try {
        await work();
      } catch {
        // Best effort by design: the versions stay with iCloud until a later attempt.
      }
    });
  }
}

export interface CloudConflicts {
  /** Hand this to the filesystem service so folder activity reaches the coordinator. */
  readonly observer: FileSystemV2Observer;
  refresh(): void;
  dispose(): void;
}

/**
 * Start collecting set-aside iCloud versions, or return null where this build
 * has no helper: every platform but macOS, and a source checkout that has not
 * run `npm run stage:cloud-helper`.
 */
export function createCloudConflicts(
  location: CloudHelperLocation,
  createClient: (binaryPath: string) => CloudConflictClient = (binaryPath) =>
    new CloudHelper(binaryPath),
): CloudConflicts | null {
  const binary = resolveCloudHelperBinary(location);
  if (!binary) return null;
  const coordinator = new CloudConflictCoordinator(createClient(binary));
  return {
    observer: {
      opened: (rootPath) => coordinator.workspaceOpened(rootPath),
      closed: (rootPath) => coordinator.workspaceClosed(rootPath),
      touched: (rootPath, itemPath) => coordinator.documentTouched(rootPath, itemPath),
    },
    refresh: () => coordinator.refresh(),
    dispose: () => coordinator.dispose(),
  };
}
