/**
 * IPC handlers for shell-level operations (reveal in Finder, open external).
 */

import { ipcMain, shell } from 'electron';

export function registerShellIpc(): void {
  ipcMain.handle('shell:revealInFolder', async (_e, absolutePath: string) => {
    shell.showItemInFolder(absolutePath);
  });

  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    // Only allow http(s) — no file:// or custom schemes from the renderer.
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      await shell.openExternal(url);
    } catch {
      // bad URL, ignore
    }
  });
}
