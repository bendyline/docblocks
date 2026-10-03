/**
 * Native menu — File, Edit, View, Window, Help.
 *
 * Menu items send typed commands to the renderer via `menu:command`
 * events; the DocBlocksShell dispatches these to existing handlers.
 */

import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from '@bendyline/docblocks/host';
import { isStoreBuild } from './updater.js';
import { reloadWindowWithPreparation } from './window-lifecycle.js';

/**
 * @param getWindow Resolves the live main window at click time. On macOS the
 *   application menu outlives every window, so a window captured when the menu
 *   was built may be destroyed by the time an item is chosen.
 */
export function buildMenu(getWindow: () => BrowserWindow | null, gitAvailable: boolean): void {
  const send = (cmd: MenuCommand): void => {
    getWindow()?.webContents.send('menu:command', cmd);
  };
  const reload = (ignoreCache?: boolean): void => {
    const win = getWindow();
    if (win) void reloadWindowWithPreparation(win, ignoreCache);
  };
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
                      click: () => send('help:checkForUpdates'),
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
          click: () => send('file:new'),
        },
        {
          label: 'Open Folder...',
          accelerator: 'CmdOrCtrl+O',
          click: () => send('file:openFolder'),
        },
        {
          label: isMac ? 'Reveal Workspace in Finder' : 'Show Workspace in Explorer',
          click: () => send('file:revealWorkspace'),
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
    // Keep native Git commands in sync with the renderer's process-lifetime
    // capability. Once Git is available, the renderer explains when the active
    // workspace is not a repository.
    ...(!gitAvailable
      ? []
      : ([
          {
            label: 'Git',
            submenu: [
              { label: 'Commit...', click: () => send('git:commit') },
              { label: 'Push', click: () => send('git:push') },
              { label: 'Pull', click: () => send('git:pull') },
              { label: 'Fetch', click: () => send('git:fetch') },
              { type: 'separator' },
              { label: 'New Branch...', click: () => send('git:newBranch') },
              { label: 'Switch Branch...', click: () => send('git:switchBranch') },
              { type: 'separator' },
              { label: 'Commit History', click: () => send('git:history') },
              { type: 'separator' },
              { label: 'Clone Repository...', click: () => send('git:clone') },
              { type: 'separator' },
              { label: 'Open on Remote', click: () => send('git:openOnRemote') },
              {
                label: 'Create Pull Request',
                click: () => send('git:createPullRequest'),
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
          click: () => reload(),
        },
        {
          label: 'Force Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => reload(true),
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
        { label: 'About DocBlocks', click: () => send('help:about') },
        { label: 'View on GitHub', click: () => send('help:viewOnGitHub') },
        ...(!isMac && showUpdateCheck
          ? [
              {
                label: 'Check for Updates...',
                click: () => send('help:checkForUpdates'),
              } as MenuItemConstructorOptions,
            ]
          : []),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
