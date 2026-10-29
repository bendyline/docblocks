import type { MenuItemConstructorOptions } from 'electron';

/**
 * The macOS application menu. The About, Hide and Quit roles default to
 * labels built from app.name, which a packaged build takes from package.json
 * ("docblocks-desktop") because the app sets no productName; adding one would
 * move app.getPath('userData') and strand every existing install's settings.
 * Explicit labels show the product name instead.
 */
export function buildMacAppMenuTemplate(options: {
  showUpdateCheck: boolean;
  checkForUpdates: () => void;
}): MenuItemConstructorOptions {
  return {
    label: 'DocBlocks',
    submenu: [
      { label: 'About DocBlocks', role: 'about' },
      ...(options.showUpdateCheck
        ? ([
            { type: 'separator' },
            { label: 'Check for Updates...', click: options.checkForUpdates },
          ] satisfies MenuItemConstructorOptions[])
        : []),
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { label: 'Hide DocBlocks', role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { label: 'Quit DocBlocks', role: 'quit' },
    ],
  };
}
