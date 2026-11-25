import type { Page } from '@playwright/test';

/**
 * A touch drag through Chromium's own input pipeline. Synthetic DOM events
 * would skip the part that matters: the browser deciding, from touch-action,
 * whether a sideways move is its scroll or the page's pointer drag.
 */
export async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  /** Runs with the finger halfway there and still down. */
  midway?: () => Promise<void>,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const STEPS = 12;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y, id: 1 }],
  });
  for (let step = 1; step <= STEPS; step++) {
    if (step === STEPS / 2 + 1) await midway?.();
    const t = step / STEPS;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, id: 1 }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
