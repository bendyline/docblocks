/**
 * Persisted app settings — a small JSON file in Electron's userData.
 * Holds the list of registered workspace roots (so the fs whitelist can
 * be rebuilt on launch) and the user's chosen default folder path.
 *
 * Writes are:
 *   • **atomic** — we write to `settings.json.tmp` and then rename into
 *     place so a crash mid-write can never leave half a JSON file on disk
 *   • **debounced** — rapid updateSettings calls (rename workspace,
 *     register, etc.) collapse into a single disk flush
 *
 * Call flushSettings() from the main process's `before-quit` handler to
 * guarantee pending updates are committed before the app exits.
 *
 * Pattern adapted from
 * /Volumes/Bendyline/gh/qualla-internal/app/src/main/UserDataStore.ts
 */

import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface PersistedWorkspace {
  id: string;
  name: string;
  rootPath: string;
}

export interface Settings {
  /** Absolute path the first-launch bootstrap should use. */
  defaultWorkspaceRoot?: string;
  /** All folders the user has opened — rebuilt into the fs whitelist. */
  workspaces: PersistedWorkspace[];
  /** Whether the user has been shown the iCloud mitigation dialog. */
  iCloudPromptShown?: boolean;
}

const DEFAULT_SETTINGS: Settings = { workspaces: [] };

/** Debounce window — how long to coalesce updateSettings calls. */
const DEBOUNCE_MS = 200;

/** In-memory cache of the most recently computed settings. */
let cachedSettings: Settings | null = null;
/** The settings snapshot awaiting flush to disk. */
let pendingSettings: Settings | null = null;
/** Timer for the debounced flush. */
let flushTimer: NodeJS.Timeout | null = null;
/** Promise that resolves when the current in-flight write completes. */
let inflight: Promise<void> = Promise.resolve();

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, contents, 'utf8');
  // fs.rename on Windows can EPERM if the destination is held open by
  // another process. We retry a handful of times with a small backoff;
  // almost always the first retry succeeds.
  const maxAttempts = 5;
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function readSettings(): Promise<Settings> {
  if (cachedSettings) return cachedSettings;
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    cachedSettings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      workspaces: parsed.workspaces ?? [],
    };
  } catch {
    cachedSettings = { ...DEFAULT_SETTINGS };
  }
  return cachedSettings;
}

async function commit(snapshot: Settings): Promise<void> {
  await atomicWrite(settingsPath(), JSON.stringify(snapshot, null, 2));
}

/** Force an immediate synchronous-looking flush. Safe to call anywhere. */
export async function flushSettings(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingSettings) {
    const snapshot = pendingSettings;
    pendingSettings = null;
    inflight = inflight.then(() => commit(snapshot));
  }
  await inflight;
}

/** Replace the current settings and schedule a debounced flush. */
export async function writeSettings(settings: Settings): Promise<void> {
  cachedSettings = settings;
  pendingSettings = settings;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!pendingSettings) return;
    const snapshot = pendingSettings;
    pendingSettings = null;
    inflight = inflight.then(() => commit(snapshot));
  }, DEBOUNCE_MS);
}

/**
 * Read the current settings, apply `update`, and persist. The updater may
 * mutate the passed snapshot in place or return a fresh object.
 */
export async function updateSettings(update: (s: Settings) => Settings | void): Promise<Settings> {
  const current = await readSettings();
  const draft: Settings = { ...current, workspaces: [...current.workspaces] };
  const next = update(draft) ?? draft;
  await writeSettings(next);
  return next;
}
