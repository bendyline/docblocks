import { expect } from 'chai';
import { useKeyboardInset } from '../src/layout/useKeyboardInset.js';
import { act, renderHook } from './helpers/renderHook.js';

const LAYOUT_HEIGHT = 800;

/** A visual viewport whose height the test sets, as the keyboard would. */
class FakeVisualViewport extends EventTarget {
  height = LAYOUT_HEIGHT;
  offsetTop = 0;
}

function box(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 300,
    width: 300,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function insetPx(): number {
  return parseInt(document.documentElement.style.getPropertyValue('--db-keyboard-inset'), 10) || 0;
}

describe('useKeyboardInset', () => {
  const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
  const originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  const originalClientRects = Range.prototype.getClientRects;
  let viewport: FakeVisualViewport;
  let scroller: HTMLElement;
  let editor: HTMLElement;
  let text: Text;
  let caretBottom: number;

  beforeEach(() => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: LAYOUT_HEIGHT });
    viewport = new FakeVisualViewport();
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });

    // The editor's scroller fills the layout viewport, less the inset the
    // shell pads its pane with.
    scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 });
    scroller.getBoundingClientRect = () => box(100, LAYOUT_HEIGHT - insetPx());
    editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.innerHTML = '<p>The aircraft is fast.</p>';
    scroller.append(editor);
    document.body.append(scroller);
    text = editor.querySelector('p')!.firstChild as Text;

    caretBottom = 700;
    Range.prototype.getClientRects = function () {
      const rects = [box(caretBottom - 20, caretBottom)];
      return Object.assign(rects, { item: (i: number) => rects[i] ?? null }) as DOMRectList;
    };
  });

  afterEach(() => {
    Range.prototype.getClientRects = originalClientRects;
    if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight);
    if (originalViewport) Object.defineProperty(window, 'visualViewport', originalViewport);
    else delete (window as { visualViewport?: unknown }).visualViewport;
    scroller.remove();
  });

  function focusCaret(): void {
    editor.focus();
    document.getSelection()!.collapse(text, 4);
  }

  async function raiseKeyboard(height: number): Promise<void> {
    viewport.height = LAYOUT_HEIGHT - height;
    await act(async () => {
      viewport.dispatchEvent(new Event('resize'));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
  }

  it('publishes the covered height and clears it on unmount', async () => {
    const hook = await renderHook(useKeyboardInset, true);
    expect(insetPx()).to.equal(0);
    await raiseKeyboard(320);
    expect(insetPx()).to.equal(320);
    await hook.unmount();
    expect(document.documentElement.style.getPropertyValue('--db-keyboard-inset')).to.equal('');
  });

  it('scrolls a caret the keyboard covers up above it', async () => {
    focusCaret();
    const hook = await renderHook(useKeyboardInset, true);
    await raiseKeyboard(300);
    // The keyboard's top is at 500; the caret clears it by 12px.
    expect(scroller.scrollTop).to.equal(700 - (500 - 12));
    await hook.unmount();
  });

  it('leaves a caret the keyboard does not reach where it is', async () => {
    caretBottom = 300;
    focusCaret();
    const hook = await renderHook(useKeyboardInset, true);
    await raiseKeyboard(300);
    expect(scroller.scrollTop).to.equal(0);
    await hook.unmount();
  });

  it('does not scroll while the keyboard is going down', async () => {
    focusCaret();
    const hook = await renderHook(useKeyboardInset, true);
    await raiseKeyboard(300);
    scroller.scrollTop = 0;
    caretBottom = 780;
    await raiseKeyboard(100);
    expect(scroller.scrollTop).to.equal(0);
    await hook.unmount();
  });

  it('leaves the editor alone when a text field has focus', async () => {
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    const hook = await renderHook(useKeyboardInset, true);
    await raiseKeyboard(300);
    expect(scroller.scrollTop).to.equal(0);
    await hook.unmount();
    field.remove();
  });

  it('does nothing when disabled', async () => {
    focusCaret();
    const hook = await renderHook(useKeyboardInset, false);
    await raiseKeyboard(300);
    expect(insetPx()).to.equal(0);
    expect(scroller.scrollTop).to.equal(0);
    await hook.unmount();
  });
});
