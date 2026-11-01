import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export const WINDOW_DRAG_GRIP_TOOLTIP = 'Use this grippie to drag and move your window around.';

// Squisq's TooltipLayer delay, so the grip's hint keeps pace with its neighbours.
const SHOW_DELAY_MS = 180;
// Leaving the window straight from the armed grip reaches the page as nothing,
// so the hint retires on its own, as a native tooltip does.
const AUTO_HIDE_MS = 5000;
const EDGE_PADDING_PX = 8;

interface TooltipPosition {
  top: number;
  anchorX: number;
}

/**
 * The dotted grip that ends the sidebar titlebar on desktop and in the
 * installed web app's Window Controls Overlay mode, plus its hover hint.
 *
 * A drag region (`app-region: drag`) belongs to the OS caption, so Chromium
 * never delivers hover to it and neither `title` nor the `data-tooltip` layer
 * can describe it. The grip therefore yields to the page while the pointer is
 * elsewhere (`--detect-hover`, `no-drag`) so the pointer's arrival is seen.
 * Arriving arms it as a drag region again, so a press still moves the window
 * natively, and starts the hint. From then on the page hears nothing, not even
 * a `mouseout` (which is why the shared `data-tooltip` layer would close
 * at once), so the hint closes on the next pointer movement over the page, on
 * blur, or after AUTO_HIDE_MS.
 */
export function WindowDragGrip() {
  const gripRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors `armed` so the document-wide pointermove listener can return
  // early without scheduling a render for every movement.
  const armedRef = useRef(true);
  const [armed, setArmed] = useState(true);
  const [tooltip, setTooltip] = useState<TooltipPosition | null>(null);

  const clearTimers = () => {
    if (showTimerRef.current) clearTimeout(showTimerRef.current);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    showTimerRef.current = null;
    hideTimerRef.current = null;
  };

  const handlePointerEnter = (event: React.PointerEvent<HTMLSpanElement>) => {
    // Touch never hovers; the grip is already a drag region for it.
    if (event.pointerType === 'touch') return;
    armedRef.current = true;
    setArmed(true);
    clearTimers();
    const grip = event.currentTarget;
    showTimerRef.current = setTimeout(() => {
      const rect = grip.getBoundingClientRect();
      setTooltip({ top: rect.bottom + 6, anchorX: rect.left + rect.width / 2 });
      hideTimerRef.current = setTimeout(() => setTooltip(null), AUTO_HIDE_MS);
    }, SHOW_DELAY_MS);
  };

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!armedRef.current || event.pointerType === 'touch') return;
      // Entering the grip delivers one move to the grip itself before the
      // armed drag region takes over; only movement elsewhere disarms it.
      if (gripRef.current?.contains(event.target as Node | null)) return;
      armedRef.current = false;
      setArmed(false);
      clearTimers();
      setTooltip(null);
    };
    const handleBlur = () => {
      clearTimers();
      setTooltip(null);
    };
    document.addEventListener('pointermove', handlePointerMove, true);
    window.addEventListener('blur', handleBlur);
    return () => {
      clearTimers();
      document.removeEventListener('pointermove', handlePointerMove, true);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  useLayoutEffect(() => {
    const node = tooltipRef.current;
    if (!tooltip || !node) return;
    const width = node.getBoundingClientRect().width;
    const maxLeft = Math.max(EDGE_PADDING_PX, window.innerWidth - EDGE_PADDING_PX - width);
    node.style.left = `${Math.min(maxLeft, Math.max(EDGE_PADDING_PX, tooltip.anchorX - width / 2))}px`;
    node.style.visibility = 'visible';
  }, [tooltip]);

  return (
    <>
      <span
        ref={gripRef}
        className={`db-window-drag-grip${armed ? '' : ' db-window-drag-grip--detect-hover'}`}
        aria-hidden={true}
        onPointerEnter={handlePointerEnter}
      />
      {tooltip &&
        createPortal(
          // The grip is decorative to assistive technology, and so is its hint.
          <div
            ref={tooltipRef}
            className="squisq-tooltip db-window-drag-grip-tooltip"
            aria-hidden={true}
            style={{
              position: 'fixed',
              top: tooltip.top,
              left: tooltip.anchorX,
              visibility: 'hidden',
            }}
          >
            {WINDOW_DRAG_GRIP_TOOLTIP}
          </div>,
          document.body,
        )}
    </>
  );
}
