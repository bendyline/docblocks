/**
 * Persisted app settings — a small JSON file in Electron's userData.
 * Holds the list of registered workspace roots (so the fs whitelist can
 * be rebuilt on launch) and the user's chosen default folder path.
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

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export async function readSettings(): Promise<Settings> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      workspaces: parsed.workspaces ?? [],
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function writeSettings(settings: Settings): Promise<void> {
  const file = settingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(settings, null, 2), 'utf8');
}

export async function updateSettings(update: (s: Settings) => Settings | void): Promise<Settings> {
  const current = await readSettings();
  const next = update({ ...current, workspaces: [...current.workspaces] }) ?? current;
  await writeSettings(next);
  return next;
}
