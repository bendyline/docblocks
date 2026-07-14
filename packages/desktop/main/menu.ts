/**
 * Native menu — File, Edit, View, Window, Help.
 *
 * Menu items send typed commands to the renderer via `menu:command`
 * events; the DocBlocksShell dispatches these to existing handlers.
 */

import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from '@bendyline/docblocks/host';
import { isStoreBuild } from './updater.js';
import { gitFeaturesDisabled } from './git/detect.js';
import { reloadWindowWithPreparation } from './window-lifecycle.js';

function send(win: BrowserWindow, cmd: MenuCommand): void {
  win.webContents.send('menu:command', cmd);
}

export function buildMenu(win: BrowserWindow): void {
  const isMac = process.platform === 'darwin';
  // Store-distributed builds update through the store, so the manual
  // "Check for Updates" affordance would be misleading — omit it.
  const showUpdateCheck = !isStoreBuild();

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              ...(showUpdateCheck
                ? ([
                    { type: 'separator' },
                    {
                      label: 'Check for Updates...',
                      click: () => send(win, 'help:checkForUpdates'),
                    },
                  ] as MenuItemConstructorOptions[])
                : []),
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
    // Git features spawn the user's system git, which the Mac App Store
    // sandbox forbids — hide the whole menu there. Items are always enabled;
    // the renderer explains when the active workspace isn't a repository.
    ...(gitFeaturesDisabled()
      ? []
      : ([
          {
            label: 'Git',
            submenu: [
              { label: 'Commit...', click: () => send(win, 'git:commit') },
              { label: 'Push', click: () => send(win, 'git:push') },
              { label: 'Pull', click: () => send(win, 'git:pull') },
              { label: 'Fetch', click: () => send(win, 'git:fetch') },
              { type: 'separator' },
              { label: 'New Branch...', click: () => send(win, 'git:newBranch') },
              { label: 'Switch Branch...', click: () => send(win, 'git:switchBranch') },
              { type: 'separator' },
              { label: 'Commit History', click: () => send(win, 'git:history') },
              { type: 'separator' },
              { label: 'Clone Repository...', click: () => send(win, 'git:clone') },
              { type: 'separator' },
              { label: 'Open on Remote', click: () => send(win, 'git:openOnRemote') },
              {
                label: 'Create Pull Request',
                click: () => send(win, 'git:createPullRequest'),
              },
            ],
          },
        ] as MenuItemConstructorOptions[])),
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => void reloadWindowWithPreparation(win),
        },
        {
          label: 'Force Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => void reloadWindowWithPreparation(win, true),
        },
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
        ...(!isMac && showUpdateCheck
          ? [
              {
                label: 'Check for Updates...',
                click: () => send(win, 'help:checkForUpdates'),
              } as MenuItemConstructorOptions,
            ]
          : []),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
