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
import { decodeUtf8Text } from '@bendyline/docblocks/filesystem';
import { SETTINGS_MAX_BYTES, parseSettings, type Settings } from './settings-schema.js';
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
    const file = settingsPath();
    const bytes = await fs.readFile(file);
    if (bytes.byteLength > SETTINGS_MAX_BYTES) {
      throw new Error(`Desktop settings exceed the ${SETTINGS_MAX_BYTES}-byte limit`);
    }
    const raw = decodeUtf8Text(bytes, { label: 'Desktop settings', path: file });
    cachedSettings = parseSettings(JSON.parse(raw) as unknown);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    cachedSettings = { ...DEFAULT_SETTINGS, workspaces: [] };
  }
  return cachedSettings;
}

async function commit(snapshot: Settings): Promise<void> {
  await atomicWrite(settingsPath(), JSON.stringify(snapshot, null, 2));
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
