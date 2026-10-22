import type { App, BrowserWindow } from 'electron';

type ActivatableApp = Pick<App, 'focus' | 'isHidden' | 'show'>;
type ActivatableWindow = Pick<BrowserWindow, 'focus' | 'isMinimized' | 'restore' | 'show'>;

interface RevealableWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  show(): void;
  once(event: 'ready-to-show', listener: () => void): unknown;
  readonly webContents: {
    once(event: 'did-finish-load', listener: () => void): unknown;
  };
}

/**
 * Show a window created with `show: false` once it can paint, then run
 * `onFirstShow` exactly once.
 *
 * `ready-to-show` alone is not enough. Under Wayland — Ubuntu's default
 * session — a hidden window's `ready-to-show` never fires, so the app kept
 * running with no window on screen and never delivered its launch files. The
 * page finishing its load is the fallback: whichever signal arrives first
 * shows the window.
 */
export function showWhenReady(win: RevealableWindow, onFirstShow: () => void): void {
  let shown = false;
  const reveal = (): void => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    if (!win.isVisible()) win.show();
    onFirstShow();
  };
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', reveal);
}

/**
 * Bring the main window forward in response to an explicit user action.
 *
 * A macOS status-bar menu does not activate its owning application. Focusing
 * only the BrowserWindow can therefore leave a visible window behind another
 * app, which is especially easy to miss when it lives on another display or
 * Space. Activate the app before focusing the requested window; `steal` is
 * appropriate here because every caller is handling a direct user gesture.
 */
export function showAndFocusWindow(
  appInstance: ActivatableApp,
  win: ActivatableWindow,
  platform: NodeJS.Platform = process.platform,
): void {
  if (win.isMinimized()) win.restore();

  if (platform === 'darwin') {
    if (appInstance.isHidden()) appInstance.show();
    appInstance.focus({ steal: true });
  }

  win.show();
  win.focus();
}
