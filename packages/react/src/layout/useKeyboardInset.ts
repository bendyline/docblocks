import { useEffect } from 'react';

/** Room kept between the caret and the top of the keyboard. */
const CARET_CLEARANCE = 12;

/**
 * Publish the height the on-screen keyboard is covering as
 * `--db-keyboard-inset`, and keep the caret above the keyboard as it rises.
 *
 * `interactive-widget=resizes-content` in the viewport meta makes Chrome
 * Android resize the layout viewport, so `100dvh` already accounts for the
 * keyboard there. iOS does not: the layout viewport keeps its full height and
 * the keyboard simply covers the bottom of it, so anything bottom-anchored
 * (the status bar, the sidebar footer) ends up underneath. `visualViewport` is
 * the only reliable way to measure that overlap.
 *
 * iOS would otherwise reveal a caret the keyboard covers by sliding the whole
 * page up, toolbars and all; the iOS app holds the page still instead. So once
 * the inset has lifted the editor's bottom edge, the caret is scrolled back
 * into view inside the editor's own scroller.
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
      const rising = inset > Math.max(last, 0);
      last = inset;
      root.style.setProperty('--db-keyboard-inset', `${inset}px`);
      if (rising) revealCaret(window.innerHeight - inset);
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

/**
 * Scroll the focused editor's caret up out from under the keyboard, whose top
 * edge sits at `keyboardTop` in client coordinates. Only rich-text editors are
 * handled: a text field's caret can't be measured, and dialogs keep their
 * fields above the keyboard through the inset.
 */
function revealCaret(keyboardTop: number): void {
  const editable = document.activeElement;
  if (!(editable instanceof HTMLElement) || !editable.isContentEditable) return;
  const caret = caretBox(editable);
  if (!caret) return;
  const scroller = scrollParent(caret.anchor);
  if (!scroller) return;
  const visibleBottom =
    Math.min(scroller.getBoundingClientRect().bottom, keyboardTop) - CARET_CLEARANCE;
  const hidden = caret.rect.bottom - visibleBottom;
  if (hidden > 0) scroller.scrollTop += hidden;
}

/** Where the selection's moving end is drawn, and the element holding it. */
function caretBox(editable: HTMLElement): { anchor: Element; rect: DOMRect } | null {
  const selection = document.getSelection();
  const node = selection?.focusNode;
  if (!selection || !node || !editable.contains(node)) return null;
  const anchor = node instanceof Element ? node : node.parentElement;
  if (!anchor) return null;

  const range = document.createRange();
  range.setStart(node, selection.focusOffset);
  const rects = range.getClientRects();
  const rect = rects.length > 0 ? rects[rects.length - 1] : null;
  if (rect && rect.height > 0) return { anchor, rect };
  // A collapsed range in an empty line has no box; its block stands in, but
  // the whole editor would be no guide to where the caret is.
  if (anchor === editable) return null;
  return { anchor, rect: anchor.getBoundingClientRect() };
}

function scrollParent(from: Element): HTMLElement | null {
  for (let element: Element | null = from; element; element = element.parentElement) {
    if (!(element instanceof HTMLElement)) continue;
    const { overflowY } = getComputedStyle(element);
    const scrolls = overflowY === 'auto' || overflowY === 'scroll';
    if (scrolls && element.scrollHeight > element.clientHeight) return element;
  }
  return null;
}
