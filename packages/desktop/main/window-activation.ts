import type { App, BrowserWindow } from 'electron';

type ActivatableApp = Pick<App, 'focus' | 'isHidden' | 'show'>;
type ActivatableWindow = Pick<BrowserWindow, 'focus' | 'isMinimized' | 'restore' | 'show'>;

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
