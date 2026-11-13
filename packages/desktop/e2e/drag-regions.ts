import type { Locator, Page } from '@playwright/test';

export interface ViewportPoint {
  x: number;
  y: number;
}

/**
 * Whether a press at each viewport point would move the window, as Chromium
 * and Electron compute it. CDP input skips the OS caption hit test, so a
 * renderer test cannot press a drag region and watch the window move; it can
 * replay the computation instead:
 *
 * - Blink (`LocalFrameView::CollectDraggableRegions`,
 *   `LayoutObject::AddDraggableRegions`) walks the layout tree in document
 *   order and records every visible box whose app-region is `drag` or
 *   `no-drag`, mapped to the window with `LocalToAbsoluteRect`: transforms
 *   and scroll offsets apply, ancestor overflow clipping does not. Inline
 *   boxes and text record nothing.
 * - Electron (`DraggableRegionsToSkRegion`) folds those boxes in order, a
 *   `drag` box adding its rectangle and a `no-drag` box subtracting it, so a
 *   later box wins wherever two overlap regardless of which one is painted
 *   on top.
 *
 * `getBoundingClientRect()` is that same unclipped, transformed border box.
 * Pseudo-element regions (the empty-state drag strips) are not modelled.
 */
export async function windowDragsAt(
  page: Page,
  points: readonly ViewportPoint[],
): Promise<boolean[]> {
  return page.evaluate((probes) => {
    const regions: Array<{ draggable: boolean; rect: DOMRect }> = [];
    const collect = (element: Element): void => {
      const style = getComputedStyle(element);
      const mode =
        style.getPropertyValue('-webkit-app-region') || style.getPropertyValue('app-region');
      if (
        (mode === 'drag' || mode === 'no-drag') &&
        style.visibility === 'visible' &&
        style.display !== 'inline' &&
        style.display !== 'contents'
      ) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) regions.push({ draggable: mode === 'drag', rect });
      }
      for (const child of element.children) collect(child);
    };
    collect(document.documentElement);
    return probes.map(({ x, y }) =>
      regions.reduce(
        (drags, { draggable, rect }) =>
          x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom ? draggable : drags,
        false,
      ),
    );
  }, points);
}

export async function centerOf(locator: Locator): Promise<ViewportPoint> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Element has no layout box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
