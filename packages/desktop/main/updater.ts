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

import { app, BrowserWindow, ipcMain } from 'electron';
import pkg, { type UpdateInfo } from 'electron-updater';
import type { UpdaterStatus } from '@bendyline/docblocks/host';

const { autoUpdater } = pkg;

const RELEASE_URL_BASE = 'https://github.com/bendyline/docblocks/releases/tag';

let lastStatus: UpdaterStatus = { kind: 'not-available' };

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
  lastStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('updater:status', status);
  }
}

export function initAutoUpdater(): void {
  autoUpdater.autoDownload = true;
  // Let the renderer drive installation — no silent quit-and-install on
  // app quit, since the renderer banner gives the user an explicit CTA.
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => broadcast({ kind: 'checking' }));
  autoUpdater.on('update-available', (info: UpdateInfo) =>
    broadcast({
      kind: 'available',
      version: info.version,
      releaseNotes: releaseNotesOf(info),
      releaseUrl: releaseUrlFor(info.version),
    }),
  );
  autoUpdater.on('update-not-available', () => broadcast({ kind: 'not-available' }));
  autoUpdater.on('download-progress', (info) =>
    broadcast({ kind: 'downloading', percent: info.percent }),
  );
  autoUpdater.on('update-downloaded', (info: UpdateInfo) =>
    broadcast({
      kind: 'downloaded',
      version: info.version,
      releaseNotes: releaseNotesOf(info),
      releaseUrl: releaseUrlFor(info.version),
    }),
  );
  autoUpdater.on('error', (err) =>
    broadcast({ kind: 'error', message: err?.message ?? 'Update error' }),
  );

  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.warn('[updater] initial check failed:', err);
  });
}

export function registerUpdaterIpc(): void {
  ipcMain.handle('updater:checkForUpdates', async (): Promise<boolean> => {
    try {
      const res = await autoUpdater.checkForUpdates();
      return !!res?.updateInfo && res.updateInfo.version !== app.getVersion();
    } catch {
      return false;
    }
  });

  ipcMain.handle('updater:getVersion', async (): Promise<string> => {
    return app.getVersion();
  });

  ipcMain.handle('updater:getStatus', async (): Promise<UpdaterStatus> => {
    return lastStatus;
  });

  ipcMain.handle('updater:quitAndInstall', async (): Promise<void> => {
    // Must fire on the next tick so the IPC round-trip completes before
    // the process exits; otherwise the renderer gets a connection error.
    setImmediate(() => autoUpdater.quitAndInstall());
  });
}
