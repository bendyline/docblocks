import { useCallback, useEffect, useRef } from 'react';

/** Matches the platform convention on both iOS and Android. */
const LONG_PRESS_MS = 500;
/** Movement that reclassifies the press as a scroll. */
const CANCEL_SLOP_PX = 10;
/**
 * Android fires a synthetic `contextmenu` after its own long-press. Ignore one
 * within this window so the menu does not open, close, and reopen.
 */
const SYNTHETIC_CONTEXTMENU_MS = 700;

export interface LongPressHandlers {
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onPointerCancel: (event: React.PointerEvent) => void;
}

export interface UseLongPressResult {
  readonly handlers: LongPressHandlers;
  /**
   * True while a synthetic `contextmenu` from the platform's own long-press
   * should be swallowed. Call from the element's `onContextMenu`.
   */
  shouldIgnoreContextMenu: () => boolean;
}

/**
 * Long-press to open a context menu on touch.
 *
 * Android Chrome synthesises `contextmenu` from a long press, but **iOS Safari
 * does not** for a plain element — it shows the selection callout instead. So
 * touch users on iOS have no way to reach the row menu at all without this.
 *
 * Only `pointerType === 'touch'` is handled; mouse and pen keep the native
 * `contextmenu` path.
 */
export function useLongPress(
  onLongPress: (coordinates: { x: number; y: number }) => void,
): UseLongPressResult {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const firedAtRef = useRef(0);

  // Held only while a press is pending. A tree renders one of these per row,
  // so a listener kept for the component's lifetime would mean hundreds of
  // permanent document-level listeners.
  const detachScrollRef = useRef<(() => void) | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    originRef.current = null;
    detachScrollRef.current?.();
    detachScrollRef.current = null;
  }, []);

  // Release anything still pending if the row unmounts mid-press.
  useEffect(() => clear, [clear]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.pointerType !== 'touch' || !event.isPrimary) return;
      clear();
      const x = event.clientX;
      const y = event.clientY;
      originRef.current = { x, y };

      // A scroll cancels the press. Capture on the document catches scrolling
      // in any ancestor, which a handler on the row itself would miss.
      if (typeof document !== 'undefined') {
        const onScroll = (): void => clear();
        document.addEventListener('scroll', onScroll, true);
        detachScrollRef.current = () => document.removeEventListener('scroll', onScroll, true);
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        originRef.current = null;
        firedAtRef.current = Date.now();
        // Best-effort: absent on iOS and behind a user-gesture requirement
        // elsewhere, so never assume it exists.
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
          navigator.vibrate(10);
        }
        onLongPress({ x, y });
      }, LONG_PRESS_MS);
    },
    [clear, onLongPress],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const origin = originRef.current;
      if (!origin) return;
      const moved =
        Math.abs(event.clientX - origin.x) > CANCEL_SLOP_PX ||
        Math.abs(event.clientY - origin.y) > CANCEL_SLOP_PX;
      if (moved) clear();
    },
    [clear],
  );

  const shouldIgnoreContextMenu = useCallback(
    () => Date.now() - firedAtRef.current < SYNTHETIC_CONTEXTMENU_MS,
    [],
  );

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: clear,
      onPointerCancel: clear,
    },
    shouldIgnoreContextMenu,
  };
}
