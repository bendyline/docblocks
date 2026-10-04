import type { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';
import type { DisplayCaptureSource } from './permission-policy.js';

/** A native, keyboard-accessible picker; source IDs never leave main. */
export function pickDisplayCaptureSource(
  window: BrowserWindow,
  sources: readonly DisplayCaptureSource[],
  createMenu: (items: MenuItemConstructorOptions[]) => Menu,
): Promise<DisplayCaptureSource | null> {
  if (window.isDestroyed() || sources.length === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const contents = window.webContents;
    let settled = false;
    let menu: Menu | undefined;
    const finish = (source: DisplayCaptureSource | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      contents.removeListener('did-start-navigation', cancel);
      contents.removeListener('destroyed', cancel);
      window.removeListener('closed', cancel);
      menu?.closePopup();
      resolve(source);
    };
    const cancel = () => finish(null);
    const timeout = setTimeout(cancel, 120_000);
    contents.once('did-start-navigation', cancel);
    contents.once('destroyed', cancel);
    window.once('closed', cancel);
    const items: MenuItemConstructorOptions[] = [
      { label: 'Choose what to record', enabled: false },
      { type: 'separator' },
    ];
    for (const [prefix, label] of [
      ['screen:', 'Screens'],
      ['window:', 'Application windows'],
    ] as const) {
      const choices = sources.filter((source) => source.id.startsWith(prefix)).slice(0, 100);
      if (!choices.length) continue;
      items.push({
        label,
        submenu: choices.map((source) => ({
          // Native Windows menus treat ampersands as access-key markers.
          label: source.name
            .replace(/[\r\n\t]/g, ' ')
            .slice(0, 160)
            .replace(/&/g, '&&'),
          click: () => finish(source),
        })),
      });
    }
    items.push({ type: 'separator' }, { label: 'Cancel', click: cancel });
    try {
      menu = createMenu(items);
      menu.popup({ window, callback: cancel });
    } catch {
      cancel();
    }
  });
}
