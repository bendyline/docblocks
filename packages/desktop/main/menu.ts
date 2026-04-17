/**
 * Native menu — File, Edit, View, Window, Help.
 *
 * Menu items send typed commands to the renderer via `menu:command`
 * events; the DocBlocksShell dispatches these to existing handlers.
 */

import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from '@bendyline/docblocks/host';

function send(win: BrowserWindow, cmd: MenuCommand): void {
  win.webContents.send('menu:command', cmd);
}

export function buildMenu(win: BrowserWindow): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Check for Updates...', click: () => send(win, 'help:checkForUpdates') },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Document',
          accelerator: 'CmdOrCtrl+N',
          click: () => send(win, 'file:new'),
        },
        {
          label: 'Open Folder...',
          accelerator: 'CmdOrCtrl+O',
          click: () => send(win, 'file:openFolder'),
        },
        {
          label: isMac ? 'Reveal Workspace in Finder' : 'Show Workspace in Explorer',
          click: () => send(win, 'file:revealWorkspace'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'About DocBlocks', click: () => send(win, 'help:about') },
        { label: 'View on GitHub', click: () => send(win, 'help:viewOnGitHub') },
        ...(isMac
          ? []
          : [
              {
                label: 'Check for Updates...',
                click: () => send(win, 'help:checkForUpdates'),
              } as MenuItemConstructorOptions,
            ]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
