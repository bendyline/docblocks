import type { BrowserWindow } from 'electron';

type TrackedWindow = Pick<BrowserWindow, 'isDestroyed'>;

/**
 * The main BrowserWindow, as every app-level entry point should see it.
 *
 * macOS keeps DocBlocks running after its last window closes, so a relaunch
 * forwarded by the single-instance lock, a Finder open-file, a docblocks://
 * link, the application menu and the tray all keep firing with no window on
 * screen. Every BrowserWindow method throws "Object has been destroyed" once
 * the native window is gone, so `current()` only ever hands out a live window,
 * and `ensure()` reopens one for a request that needs somewhere to land.
 */
export class MainWindowSlot<W extends TrackedWindow> {
  private window: W | null = null;
  private started = false;
  private reopening: Promise<void> | null = null;

  /**
   * @param reopen Creates a replacement window and adopts it with `set()`.
   * @param reportReopenFailure Surfaces a failed reopen; the process stays up.
   */
  public constructor(
    private readonly reopen: () => Promise<void>,
    private readonly reportReopenFailure: (error: unknown) => void,
  ) {}

  /** The main window while it is alive, otherwise null. */
  public current(): W | null {
    const win = this.window;
    return win && !win.isDestroyed() ? win : null;
  }

  public set(win: W): void {
    this.window = win;
    this.started = true;
  }

  /** Forget `win` once it closes, unless a newer window already replaced it. */
  public release(win: W): void {
    if (this.window === win) this.window = null;
  }

  /**
   * Reopen the main window when none is alive. Startup owns the first window,
   * so this does nothing until `set()` has run once; calls that arrive while a
   * reopen is in flight share it instead of opening a second window.
   */
  public ensure(): void {
    if (!this.started || this.reopening || this.current()) return;
    this.reopening = this.reopen()
      .catch(this.reportReopenFailure)
      .finally(() => {
        this.reopening = null;
      });
  }
}
