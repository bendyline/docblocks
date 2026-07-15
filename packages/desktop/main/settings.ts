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
import path from 'node:path';
import { type Settings } from './settings-schema.js';
import { atomicWriteSettingsFile, readSettingsFile } from './settings-file.js';
import { SettingsWriteQueue } from './settings-write-queue.js';

export type {
  PersistedExportTarget,
  PersistedExportTargetAccess,
  PersistedWorkspace,
  Settings,
} from './settings-schema.js';

const DEFAULT_SETTINGS: Settings = { workspaces: [] };

/** Debounce window — how long to coalesce updateSettings calls. */
const DEBOUNCE_MS = 200;

/** In-memory cache of the most recently computed settings. */
let cachedSettings: Settings | null = null;
/** The settings snapshot awaiting flush to disk. */
let pendingSettings: Settings | null = null;
/** Timer for the debounced flush. */
let flushTimer: NodeJS.Timeout | null = null;

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export async function readSettings(): Promise<Settings> {
  if (cachedSettings) return cachedSettings;
  cachedSettings = (await readSettingsFile(settingsPath())) ?? {
    ...DEFAULT_SETTINGS,
    workspaces: [],
  };
  return cachedSettings;
}

async function commit(snapshot: Settings): Promise<void> {
  await atomicWriteSettingsFile(settingsPath(), JSON.stringify(snapshot, null, 2));
}

const writeQueue = new SettingsWriteQueue(commit);

/** Force an immediate synchronous-looking flush. Safe to call anywhere. */
export async function flushSettings(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingSettings) {
    const snapshot = pendingSettings;
    pendingSettings = null;
    writeQueue.enqueue(snapshot);
  }
  await writeQueue.drain();
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
    writeQueue.enqueue(snapshot);
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
