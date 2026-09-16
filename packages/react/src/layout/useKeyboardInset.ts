import { useEffect } from 'react';

/**
 * Publish the height the on-screen keyboard is covering as
 * `--db-keyboard-inset`.
 *
 * `interactive-widget=resizes-content` in the viewport meta makes Chrome
 * Android resize the layout viewport, so `100dvh` already accounts for the
 * keyboard there. iOS does not: the layout viewport keeps its full height and
 * the keyboard simply covers the bottom of it, so anything bottom-anchored
 * (the status bar, the sidebar footer) ends up underneath. `visualViewport` is
 * the only reliable way to measure that overlap.
 *
 * Writes are rAF-throttled and skipped when unchanged, because this fires on
 * every scroll frame while the keyboard animates.
 */
export function useKeyboardInset(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const viewport = window.visualViewport;
    if (!viewport) return;

    const root = document.documentElement;
    let frame = 0;
    let last = -1;

    const measure = (): void => {
      frame = 0;
      // How much of the layout viewport the visual viewport no longer covers.
      const covered = window.innerHeight - (viewport.height + viewport.offsetTop);
      // Small negative values show up from rounding and from rubber-banding.
      const inset = Math.max(0, Math.round(covered));
      if (inset === last) return;
      last = inset;
      root.style.setProperty('--db-keyboard-inset', `${inset}px`);
    };

    const schedule = (): void => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(measure);
    };

    measure();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      root.style.removeProperty('--db-keyboard-inset');
    };
  }, [enabled]);
}
