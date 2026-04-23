/**
 * System tray / macOS menu bar integration.
 *
 * Adds a small tray icon with a "New Document" action that focuses the
 * main window and dispatches the file:new menu command. Optional — if the
 * resource icon is missing, the tray is silently skipped.
 */

import { Tray, Menu, nativeImage, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { MenuCommand } from '@bendyline/docblocks/host';

let tray: Tray | null = null;

function resolveIconPath(): string | null {
  const candidates = [
    path.join(__dirname, '..', '..', 'resources', 'icon.png'),
    path.join(process.resourcesPath ?? '', 'resources', 'icon.png'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

export function registerTray(getWindow: () => BrowserWindow | null): void {
  const iconPath = resolveIconPath();
  if (!iconPath) return; // no icon — don't create a broken tray

  const image = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  if (image.isEmpty()) return;

  tray = new Tray(image);
  tray.setToolTip('DocBlocks');

  const dispatch = (cmd: MenuCommand) => {
    const win = getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send('menu:command', cmd);
  };

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'New Document', click: () => dispatch('file:new') },
      { label: 'Open Folder...', click: () => dispatch('file:openFolder') },
      { type: 'separator' },
      {
        label: 'Show DocBlocks',
        click: () => {
          const win = getWindow();
          if (!win) return;
          win.show();
          win.focus();
        },
      },
      { role: 'quit' },
    ]),
  );
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
