/**
 * System tray / macOS menu bar integration — off until the user turns it on
 * in Settings, then remembered across launches in settings.json.
 *
 * The menu offers New Document, Open Folder, a shortcut per pinned document,
 * Show DocBlocks, and Quit. The renderer owns the pinned list and pushes it
 * over `menu:setPinnedDocuments`; the payload is re-validated here before any
 * menu item is built. A pinned document opens through the existing
 * `open-request` channel, the same path as a file opened from the OS.
 *
 * On macOS DocBlocks keeps running after its last window closes, so a tray
 * action can arrive with no window. It reopens one and holds the action until
 * that window's shell publishes its pinned list, which the shell does from the
 * same mount that subscribes to menu commands and open requests.
 */

import { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { parsePinnedMenuDocuments } from '@bendyline/docblocks/host';
import type { HostPinnedDocument, MenuCommand } from '@bendyline/docblocks/host';
import { assertTrustedIpcSender, registerTrustedIpcHandler } from './ipc-authority.js';
import { sendOpenRequest } from './open-requests.js';
import { readSettings, updateSettings } from './settings.js';
import { buildTrayMenuTemplate } from './tray-menu-template.js';
import { showAndFocusWindow } from './window-activation.js';

export interface TrayWindowHost {
  /** The main window while it is alive, otherwise null. */
  getWindow(): BrowserWindow | null;
  /** Reopen the main window when none is alive. */
  ensureWindow(): void;
}

type TrayAction = (win: BrowserWindow) => void;

/** Clicks that pile up while a window reopens beyond this are dropped. */
const MAX_DEFERRED_ACTIONS = 8;

let tray: Tray | null = null;
let windowHost: TrayWindowHost | null = null;
let pinnedDocuments: readonly HostPinnedDocument[] = [];
let deferredActions: TrayAction[] = [];

export function resolveIconPath(fileName = 'icon.png'): string | null {
  const candidates = [
    path.join(__dirname, '..', '..', 'resources', fileName),
    path.join(process.resourcesPath ?? '', 'resources', fileName),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

/**
 * The macOS menu bar takes a template image: the D alone, sized to the bar
 * and tinted by the system for light, dark, and inactive menu bars, where the
 * app icon shrunk to 18px left the letter undersized inside its plate.
 * createFromPath loads trayTemplate@2x.png beside it for Retina displays.
 * Windows picks the notification-area size it needs out of the .ico.
 */
function createTrayImage(): Electron.NativeImage | null {
  if (process.platform === 'darwin') {
    const templatePath = resolveIconPath('trayTemplate.png');
    if (!templatePath) return null;
    const image = nativeImage.createFromPath(templatePath);
    image.setTemplateImage(true);
    return image;
  }
  if (process.platform === 'win32') {
    const icoPath = resolveIconPath('icon.ico');
    return icoPath ? nativeImage.createFromPath(icoPath) : null;
  }
  const iconPath = resolveIconPath();
  return iconPath ? nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }) : null;
}

/** Bring the main window forward and run `action` on it, reopening it first if needed. */
function deliver(action: TrayAction): void {
  const win = windowHost?.getWindow();
  if (win) {
    showAndFocusWindow(app, win);
    action(win);
    return;
  }
  if (deferredActions.length < MAX_DEFERRED_ACTIONS) deferredActions.push(action);
  windowHost?.ensureWindow();
}

function flushDeferredActions(win: BrowserWindow): void {
  if (deferredActions.length === 0) return;
  const actions = deferredActions;
  deferredActions = [];
  showAndFocusWindow(app, win);
  for (const action of actions) action(win);
}

function sendCommand(command: MenuCommand): void {
  deliver((win) => win.webContents.send('menu:command', command));
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate(
    buildTrayMenuTemplate(pinnedDocuments, {
      newDocument: () => sendCommand('file:new'),
      openFolder: () => sendCommand('file:openFolder'),
      openPinnedDocument: (document) =>
        deliver((win) => {
          sendOpenRequest(win, {
            kind: 'workspace-file',
            workspaceId: document.workspaceId,
            path: document.path,
          });
        }),
      showWindow: () => deliver(() => undefined),
    }),
  );
}

function refreshMenu(): void {
  tray?.setContextMenu(buildMenu());
}

function showTray(): void {
  if (tray) return;
  const image = createTrayImage();
  if (!image || image.isEmpty()) return; // no icon — don't create a broken tray

  tray = new Tray(image);
  tray.setToolTip('DocBlocks');
  // Windows opens a notification-area menu on right-click only; a left click
  // conventionally brings the app forward. macOS and Linux open the menu.
  if (process.platform === 'win32') tray.on('click', () => deliver(() => undefined));
  refreshMenu();
}

function hideTray(): void {
  tray?.destroy();
  tray = null;
}

/**
 * Register the tray's IPC and show the icon when the user turned it on.
 * Call before the main window loads: its shell publishes the pinned list as
 * soon as it mounts, and a message with no listener is simply dropped.
 */
export function registerTray(host: TrayWindowHost, enabled: boolean): void {
  windowHost = host;

  ipcMain.removeAllListeners('menu:setPinnedDocuments');
  ipcMain.on('menu:setPinnedDocuments', (event, payload: unknown) => {
    try {
      assertTrustedIpcSender(event);
    } catch {
      return;
    }
    pinnedDocuments = parsePinnedMenuDocuments(payload);
    refreshMenu();
    const win = windowHost?.getWindow();
    if (win && event.sender === win.webContents) flushDeferredActions(win);
  });

  registerTrustedIpcHandler(
    'tray:getEnabled',
    0,
    async (): Promise<boolean> => (await readSettings()).tray?.enabled === true,
  );
  registerTrustedIpcHandler(
    'tray:setEnabled',
    1,
    async (_event, enabled: unknown): Promise<boolean> => {
      if (typeof enabled !== 'boolean') throw new Error('tray:setEnabled expects a boolean');
      await updateSettings((settings) => {
        settings.tray = { enabled };
      });
      if (enabled) showTray();
      else hideTray();
      return enabled;
    },
  );

  if (enabled) showTray();
}

export function destroyTray(): void {
  ipcMain.removeAllListeners('menu:setPinnedDocuments');
  ipcMain.removeHandler('tray:getEnabled');
  ipcMain.removeHandler('tray:setEnabled');
  hideTray();
  windowHost = null;
  pinnedDocuments = [];
  deferredActions = [];
}
