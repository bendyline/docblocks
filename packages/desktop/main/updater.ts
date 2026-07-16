/**
 * Auto-updater wiring.
 *
 * electron-updater with the GitHub provider (configured in
 * electron-builder.yml) downloads differential updates from
 * bendyline/docblocks releases and applies them on quit. In dev or when
 * running from an unsigned build, the updater disables itself
 * gracefully.
 *
 * The renderer sees status events via `docblocksHost.updater.onStatus`
 * and can call `quitAndInstall` once a `'downloaded'` status arrives.
 */

import { app, BrowserWindow } from 'electron';
import pkg, { type UpdateInfo } from 'electron-updater';
import type {
  UpdateCheckResult,
  UpdateInstallResult,
  UpdaterStatus,
} from '@bendyline/docblocks/host';
import { registerTrustedIpcHandler } from './ipc-authority.js';
import {
  classifyUpdateCheck,
  failedUpdateCheck,
  updaterStatusForError,
  type UpdaterActivity,
} from './updater-result.js';

const { autoUpdater } = pkg;

const RELEASE_URL_BASE = 'https://github.com/bendyline/docblocks/releases/tag';
let updateDownloaded = false;
let updaterActivity: UpdaterActivity = 'idle';

/**
 * True in store-distributed builds (Mac App Store / Microsoft Store), where
 * the store delivers updates and the app must not self-update. Electron sets
 * `process.mas` / `process.windowsStore` only in those packaged variants, so
 * this is safe to call from any process.
 */
export function isStoreBuild(): boolean {
  return process.mas === true || process.windowsStore === true;
}

function releaseUrlFor(version: string): string {
  return `${RELEASE_URL_BASE}/v${version}`;
}

function releaseNotesOf(info: UpdateInfo): string | undefined {
  // electron-updater can return a string or an array of per-version objects.
  const notes = info.releaseNotes;
  if (!notes) return undefined;
  if (typeof notes === 'string') return notes;
  return notes.map((n) => `${n.version}\n${n.note ?? ''}`).join('\n\n');
}

function broadcast(status: UpdaterStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('updater:status', status);
  }
}

export function initAutoUpdater(): void {
  // Defensive: the store delivers updates for these builds. main.ts already
  // guards this call, but never let the GitHub updater run in a store build.
  if (isStoreBuild()) return;

  autoUpdater.autoDownload = true;
  // Let the renderer drive installation — no silent quit-and-install on
  // app quit, since the renderer banner gives the user an explicit CTA.
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    updaterActivity = 'checking';
    broadcast({ kind: 'checking' });
  });
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    updaterActivity = 'downloading';
    broadcast({
      kind: 'available',
      version: info.version,
      releaseNotes: releaseNotesOf(info),
      releaseUrl: releaseUrlFor(info.version),
    });
  });
  autoUpdater.on('update-not-available', () => {
    updaterActivity = 'idle';
    broadcast({ kind: 'not-available' });
  });
  autoUpdater.on('download-progress', (info) => {
    updaterActivity = 'downloading';
    broadcast({ kind: 'downloading', percent: info.percent });
  });
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    updaterActivity = 'idle';
    updateDownloaded = true;
    broadcast({
      kind: 'downloaded',
      version: info.version,
      releaseNotes: releaseNotesOf(info),
      releaseUrl: releaseUrlFor(info.version),
    });
  });
  autoUpdater.on('error', (err) => {
    const status = updaterStatusForError(updaterActivity, err);
    updaterActivity = 'idle';
    broadcast(status);
  });

  // Not checkForUpdatesAndNotify(): that variant pops a *native OS*
  // notification once the download finishes, which belongs to the
  // notify-and-quit-install flow `autoInstallOnAppQuit = false` just opted out
  // of. The 'update-downloaded' handler above already drives the in-app
  // restart banner, so the native toast would only compete with it.
  updaterActivity = 'checking';
  autoUpdater.checkForUpdates().catch((err) => {
    // electron-updater normally emits `error` before rejecting. Preserve the
    // same quiet fallback if a provider rejects without emitting the event.
    if (updaterActivity === 'checking') {
      updaterActivity = 'idle';
      broadcast({ kind: 'not-available' });
    }
    console.warn('[updater] initial check failed:', err);
  });
}

export function registerUpdaterIpc(
  prepareForInstall: () => Promise<boolean> = async () => true,
): void {
  registerTrustedIpcHandler('updater:checkForUpdates', 0, async (): Promise<UpdateCheckResult> => {
    // Store builds are updated by the store, not by electron-updater.
    if (isStoreBuild()) return { kind: 'store-managed' };
    updaterActivity = 'checking';
    try {
      const res = await autoUpdater.checkForUpdates();
      return classifyUpdateCheck(app.getVersion(), res?.updateInfo.version);
    } catch (error: unknown) {
      const result = failedUpdateCheck(error);
      // A check failure is returned to the explicit caller for diagnostics,
      // but it is intentionally not promoted to an in-app alert.
      if (updaterActivity === 'checking') {
        updaterActivity = 'idle';
        broadcast({ kind: 'not-available' });
      }
      return result;
    }
  });

  registerTrustedIpcHandler('updater:getVersion', 0, async (): Promise<string> => {
    return app.getVersion();
  });

  registerTrustedIpcHandler('updater:quitAndInstall', 0, async (): Promise<UpdateInstallResult> => {
    if (isStoreBuild() || !updateDownloaded) return 'not-ready';
    if (!(await prepareForInstall())) return 'cancelled';
    // Must fire on the next tick so the IPC round-trip completes before
    // the process exits; otherwise the renderer gets a connection error.
    setImmediate(() => autoUpdater.quitAndInstall());
    return 'installing';
  });
}
