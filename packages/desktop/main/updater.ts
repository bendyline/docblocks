/**
 * Auto-updater wiring.
 *
 * electron-updater with the GitHub provider (configured in electron-builder.yml)
 * downloads differential updates from bendyline/docblocks releases and
 * applies them on quit. In dev or when running from an unsigned build, the
 * updater disables itself gracefully.
 */

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import pkg from 'electron-updater';
import type { UpdaterStatus } from '@bendyline/docblocks/host';

const { autoUpdater } = pkg;

let lastStatus: UpdaterStatus = { kind: 'not-available' };

function broadcast(status: UpdaterStatus): void {
  lastStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('updater:status', status);
  }
}

export function initAutoUpdater(): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => broadcast({ kind: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    broadcast({ kind: 'available', version: info.version }),
  );
  autoUpdater.on('update-not-available', () => broadcast({ kind: 'not-available' }));
  autoUpdater.on('download-progress', (info) =>
    broadcast({ kind: 'downloading', percent: info.percent }),
  );
  autoUpdater.on('update-downloaded', (info) => {
    broadcast({ kind: 'downloaded', version: info.version });
    // Offer to restart & install now.
    dialog
      .showMessageBox({
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update ready',
        message: `DocBlocks ${info.version} has been downloaded.`,
        detail: 'Restart now to install the update.',
      })
      .then((res) => {
        if (res.response === 0) {
          autoUpdater.quitAndInstall();
        }
      })
      .catch(() => undefined);
  });
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
}
