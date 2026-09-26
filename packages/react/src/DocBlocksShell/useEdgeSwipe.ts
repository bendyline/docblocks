import { useEffect, type RefObject } from 'react';

/** Distance from the start edge that begins an open gesture. */
const EDGE_ZONE_PX = 24;
/** Movement before the gesture commits to an axis. */
const AXIS_LOCK_PX = 10;
/** Fraction of the drawer width past which a release opens rather than closes. */
const COMMIT_FRACTION = 0.4;
/** px per ms — a fast flick commits regardless of distance. */
const COMMIT_VELOCITY = 0.5;

export interface EdgeSwipeOptions {
  /** The element the gesture is measured against (the pane container). */
  readonly surfaceRef: RefObject<HTMLElement | null>;
  /** The drawer being dragged. */
  readonly drawerRef: RefObject<HTMLElement | null>;
  readonly enabled: boolean;
  readonly open: boolean;
  readonly onOpen: () => void;
  readonly onClose: () => void;
}

/**
 * Edge-swipe to open the drawer, and swipe-back to close it.
 *
 * Pointer Events only, matching the sidebar resizer. `--db-drawer-progress` is
 * written straight onto the drawer node during the drag, exactly as the resizer
 * writes `style.width`, so a gesture costs zero React renders.
 *
 * Known limitation: on iOS Safari the left screen edge belongs to the system
 * interactive-back gesture, so open-by-swipe is unreliable *in the browser*. It
 * works in Android Chrome and will work in a Capacitor WKWebView, which has no
 * back gesture. The toolbar button remains the guaranteed path, and the first
 * few pixels are deliberately not `preventDefault`ed so the system gesture wins
 * cleanly rather than both half-happening.
 */
export function useEdgeSwipe({
  surfaceRef,
  drawerRef,
  enabled,
  open,
  onOpen,
  onClose,
}: EdgeSwipeOptions): void {
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!enabled || !surface) return;

    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let axis: 'undecided' | 'horizontal' | 'abandoned' = 'undecided';
    let width = 1;

    const drawer = (): HTMLElement | null => drawerRef.current;

    const setProgress = (value: number): void => {
      drawer()?.style.setProperty('--db-drawer-progress', String(value));
    };
    const clearProgress = (): void => {
      const node = drawer();
      if (!node) return;
      node.style.removeProperty('--db-drawer-progress');
      node.style.removeProperty('transition');
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (pointerId !== null || event.pointerType !== 'touch' || !event.isPrimary) return;
      const bounds = surface.getBoundingClientRect();
      const fromEdge = event.clientX - bounds.left <= EDGE_ZONE_PX;
      if (!open && !fromEdge) return;
      // While open, only a drag that starts on the drawer should close it;
      // a tap on the scrim is handled separately.
      if (open && !drawer()?.contains(event.target as Node)) return;

      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      startTime = event.timeStamp;
      axis = 'undecided';
      width = drawer()?.getBoundingClientRect().width || bounds.width || 1;
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;

      if (axis === 'undecided') {
        if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
        // Vertical first means the user is scrolling the list, not the drawer.
        axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'abandoned';
        if (axis === 'horizontal') {
          surface.setPointerCapture(event.pointerId);
          // Suppress the transition so the drawer tracks the finger exactly.
          drawer()?.style.setProperty('transition', 'none');
        }
        return;
      }
      if (axis !== 'horizontal') return;

      const base = open ? 1 : 0;
      const progress = Math.min(1, Math.max(0, base + dx / width));
      setProgress(progress);
    };

    const finish = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return;
      const wasHorizontal = axis === 'horizontal';
      pointerId = null;
      axis = 'undecided';
      if (surface.hasPointerCapture(event.pointerId)) {
        surface.releasePointerCapture(event.pointerId);
      }
      if (!wasHorizontal) return;

      const dx = event.clientX - startX;
      const elapsed = Math.max(1, event.timeStamp - startTime);
      const velocity = dx / elapsed;
      const progress = Math.min(1, Math.max(0, (open ? 1 : 0) + dx / width));

      clearProgress();
      const shouldOpen =
        velocity > COMMIT_VELOCITY
          ? true
          : velocity < -COMMIT_VELOCITY
            ? false
            : progress > COMMIT_FRACTION;
      if (shouldOpen !== open) (shouldOpen ? onOpen : onClose)();
    };

    surface.addEventListener('pointerdown', onPointerDown);
    surface.addEventListener('pointermove', onPointerMove);
    surface.addEventListener('pointerup', finish);
    surface.addEventListener('pointercancel', finish);
    return () => {
      surface.removeEventListener('pointerdown', onPointerDown);
      surface.removeEventListener('pointermove', onPointerMove);
      surface.removeEventListener('pointerup', finish);
      surface.removeEventListener('pointercancel', finish);
      clearProgress();
    };
  }, [surfaceRef, drawerRef, enabled, open, onOpen, onClose]);
}
