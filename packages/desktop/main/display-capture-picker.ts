import type { BrowserWindow, Menu, MenuItemConstructorOptions, SourcesOptions } from 'electron';
import type { DisplayCaptureSource } from './permission-policy.js';

/**
 * Every screen, then every app window, from one lookup per source type made
 * one after the other.
 *
 * A single `getSources({ types: ['screen', 'window'] })` lists both kinds
 * concurrently. On X11, WebRTC's screen capturer reads the root window under a
 * process-wide Xlib error trap, so an X error raised meanwhile by the window
 * lister fails the screen capturer: about half the time no screen came back,
 * and the picker offered windows only.
 */
export async function listDisplayCaptureSources(
  getSources: (options: SourcesOptions) => Promise<readonly DisplayCaptureSource[]>,
): Promise<DisplayCaptureSource[]> {
  const thumbnailSize = { width: 0, height: 0 };
  const screens = await getSources({ types: ['screen'], thumbnailSize });
  const windows = await getSources({ types: ['window'], thumbnailSize });
  return [...screens, ...windows];
}

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
