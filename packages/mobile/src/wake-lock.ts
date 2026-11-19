/**
 * `navigator.wakeLock` for the native web views.
 *
 * Android WebView has no Screen Wake Lock API, so the screen timed out during
 * long work. On a phone that is worse than a dark screen. The app leaves the
 * foreground, the host stops speech and model downloads, and narration
 * generation failed partway. This gives the page a Screen Wake Lock backed by
 * the platform's own switch: FLAG_KEEP_SCREEN_ON on Android, and the idle
 * timer on iOS, where WKWebView's own lock cannot be counted on inside an app.
 *
 * It keeps the standard contract, so Squisq's video export and DocBlocks' own
 * holders (react/src/hooks/screen-wake-lock.ts) use it unchanged:
 * - `request('screen')` rejects while the page is hidden.
 * - Every lock is released when the page is hidden. Holders ask again when
 *   the page returns.
 * - The screen stays on while any lock is held.
 *
 * Native also lets the screen sleep whenever the app leaves the foreground,
 * and installing resets it, so a page that stops responding or reloads
 * cannot keep the screen on.
 */

export interface WakeLockTarget {
  readonly document: Document;
  readonly navigator: Navigator;
}

class NativeWakeLockSentinel extends EventTarget implements WakeLockSentinel {
  readonly type = 'screen';
  #released = false;
  #onrelease: WakeLockSentinel['onrelease'] = null;

  constructor(private readonly drop: (sentinel: NativeWakeLockSentinel) => void) {
    super();
  }

  get released(): boolean {
    return this.#released;
  }

  // An accessor, not a field: `end()` is the only caller, in every EventTarget.
  get onrelease(): WakeLockSentinel['onrelease'] {
    return this.#onrelease;
  }

  set onrelease(handler: WakeLockSentinel['onrelease']) {
    this.#onrelease = handler;
  }

  release(): Promise<void> {
    this.drop(this);
    return Promise.resolve();
  }

  /** Mark released and tell listeners, once. */
  end(): void {
    if (this.#released) return;
    this.#released = true;
    const event = new Event('release');
    this.dispatchEvent(event);
    this.onrelease?.call(this, event);
  }
}

export function installNativeWakeLock(
  keepScreenOn: (on: boolean) => Promise<void>,
  target: WakeLockTarget = window,
): void {
  const doc = target.document;
  const held = new Set<NativeWakeLockSentinel>();
  let screenOn = false;

  /** Tell native only when the answer changes. Calls reach it in order. */
  const sync = (): void => {
    const on = held.size > 0;
    if (on === screenOn) return;
    screenOn = on;
    void keepScreenOn(on).catch(() => {
      // Best effort: the work runs either way, and the next change tries again.
    });
  };
  const drop = (sentinel: NativeWakeLockSentinel): void => {
    if (!held.delete(sentinel)) return;
    sentinel.end();
    sync();
  };
  const releaseAll = (): void => {
    for (const sentinel of [...held]) {
      held.delete(sentinel);
      sentinel.end();
    }
    sync();
  };

  const wakeLock: WakeLock = {
    request(type: WakeLockType = 'screen') {
      if (type !== 'screen')
        return Promise.reject(new TypeError(`Unsupported wake lock type: ${String(type)}`));
      if (doc.visibilityState !== 'visible')
        return Promise.reject(new DOMException('The page is not visible.', 'NotAllowedError'));
      const sentinel = new NativeWakeLockSentinel(drop);
      held.add(sentinel);
      sync();
      return Promise.resolve(sentinel);
    },
  };

  // A reloaded page holds nothing, whatever the page before it held.
  void keepScreenOn(false).catch(() => {});
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState !== 'visible') releaseAll();
  });
  doc.defaultView?.addEventListener('pagehide', releaseAll);
  // An own property shadows WKWebView's `Navigator.prototype.wakeLock`.
  Object.defineProperty(target.navigator, 'wakeLock', {
    configurable: true,
    enumerable: true,
    value: wakeLock,
  });
}
