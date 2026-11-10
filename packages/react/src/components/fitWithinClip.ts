/**
 * Keep an absolutely positioned dropdown inside the nearest ancestor that
 * clips it — the sidebar, above all, whose header buttons sit mid-row on a
 * phone, so a menu hung from either edge of its trigger ran past one side of
 * the drawer.
 *
 * The browser still scrolls a clipping ancestor to reveal a focused field, so
 * an overhanging menu with a text field (New Workspace) also shoved the whole
 * sidebar sideways. Narrow the menu if it can't fit at all, then shift it
 * whichever way it overhangs. Measures from the stylesheet's own placement
 * every time, so it can be called again after a resize.
 */

/** Clearance kept between the menu and the clipping edge. */
const EDGE_MARGIN = 4;

/** The horizontal extent of the nearest ancestor that clips `element`. */
function clippingBounds(element: HTMLElement): { left: number; right: number } {
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (getComputedStyle(ancestor).overflowX !== 'visible') {
      const rect = ancestor.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    }
  }
  return { left: 0, right: document.documentElement.clientWidth };
}

export function fitWithinClippingAncestor(dropdown: HTMLElement): void {
  dropdown.style.left = '';
  dropdown.style.right = '';
  dropdown.style.maxWidth = '';
  const bounds = clippingBounds(dropdown);
  const min = bounds.left + EDGE_MARGIN;
  const max = bounds.right - EDGE_MARGIN;
  if (dropdown.getBoundingClientRect().width > max - min) {
    dropdown.style.maxWidth = `${Math.max(0, max - min)}px`;
  }
  const rect = dropdown.getBoundingClientRect();
  // Pull back from the right edge first, then make sure the left edge (where
  // the labels start) is inside; after narrowing, both always fit.
  let shift = rect.right > max ? max - rect.right : 0;
  if (rect.left + shift < min) shift = min - rect.left;
  if (shift !== 0) {
    dropdown.style.left = `${dropdown.offsetLeft + shift}px`;
    dropdown.style.right = 'auto';
  }
}
