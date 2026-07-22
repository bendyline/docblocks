/**
 * System tray / macOS menu bar integration.
 *
 * Adds a small tray icon with a "New Document" action that focuses the
 * main window and dispatches the file:new menu command. Optional — if the
 * resource icon is missing, the tray is silently skipped.
 *
 * The tray also mirrors the renderer's pinned-document list: each pinned
 * document gets a shortcut that focuses the window and activates it through
 * the existing `open-request` channel. The renderer owns the pinned list and
 * pushes it over `menu:setPinnedDocuments`; the payload is re-validated here
 * before any menu item is built.
 */

import { Tray, Menu, nativeImage, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { parsePinnedMenuDocuments } from '@bendyline/docblocks/host';
import type { HostPinnedDocument, MenuCommand } from '@bendyline/docblocks/host';
import { sendOpenRequest } from './open-requests.js';

let tray: Tray | null = null;
let getWindow: (() => BrowserWindow | null) | null = null;
let pinnedDocuments: readonly HostPinnedDocument[] = [];

export function resolveIconPath(): string | null {
  const candidates = [
    path.join(__dirname, '..', '..', 'resources', 'icon.png'),
    path.join(process.resourcesPath ?? '', 'resources', 'icon.png'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function pinnedLabel(document: HostPinnedDocument): string {
  const base = document.path.slice(document.path.lastIndexOf('/') + 1);
  const name = base.endsWith('.md') ? base.slice(0, -3) : base;
  // The tray truncates for us on most platforms, but a hard cap keeps the
  // menu from being dominated by a single pathological title.
  return name.length > 80 ? `${name.slice(0, 79)}…` : name;
}

function dispatch(cmd: MenuCommand): void {
  const win = getWindow?.();
  if (!win) return;
  focusWindow(win);
  win.webContents.send('menu:command', cmd);
}

function activatePinnedDocument(document: HostPinnedDocument): void {
  const win = getWindow?.();
  if (!win) return;
  focusWindow(win);
  // Reuse the OS open-file path: the renderer's onOpenRequest handler resolves
  // the workspace + path and activates the document, normalizing the path.
  sendOpenRequest(win, {
    kind: 'workspace-file',
    workspaceId: document.workspaceId,
    path: document.path,
  });
}

function buildMenu(): Menu {
  const pinnedItems: Electron.MenuItemConstructorOptions[] = pinnedDocuments.map((document) => ({
    label: pinnedLabel(document),
    toolTip: `${document.workspaceName}/${document.path}`,
    click: () => activatePinnedDocument(document),
  }));

  return Menu.buildFromTemplate([
    { label: 'New Document', click: () => dispatch('file:new') },
    { label: 'Open Folder...', click: () => dispatch('file:openFolder') },
    ...(pinnedItems.length > 0
      ? ([
          { type: 'separator' },
          { label: 'Pinned', enabled: false },
          ...pinnedItems,
        ] satisfies Electron.MenuItemConstructorOptions[])
      : []),
    { type: 'separator' },
    {
      label: 'Show DocBlocks',
      click: () => {
        const win = getWindow?.();
        if (win) focusWindow(win);
      },
    },
    { role: 'quit' },
  ]);
}

function refreshMenu(): void {
  tray?.setContextMenu(buildMenu());
}

export function registerTray(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter;

  // Register the renderer→main pinned-document channel even when no tray icon
  // exists, so a later icon (or a re-registration) always has current state.
  ipcMain.removeAllListeners('menu:setPinnedDocuments');
  ipcMain.on('menu:setPinnedDocuments', (_event, payload: unknown) => {
    pinnedDocuments = parsePinnedMenuDocuments(payload);
    refreshMenu();
  });

  const iconPath = resolveIconPath();
  if (!iconPath) return; // no icon — don't create a broken tray

  const image = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  if (image.isEmpty()) return;

  tray = new Tray(image);
  tray.setToolTip('DocBlocks');
  refreshMenu();
}

export function destroyTray(): void {
  ipcMain.removeAllListeners('menu:setPinnedDocuments');
  tray?.destroy();
  tray = null;
  pinnedDocuments = [];
}
