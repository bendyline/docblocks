import { expect } from 'chai';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WINDOW_DRAG_GRIP_TOOLTIP, WindowDragGrip } from '../src/DocBlocksShell/WindowDragGrip.js';

describe('Window drag grip', () => {
  let container: HTMLDivElement;
  let elsewhere: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement('div');
    elsewhere = document.createElement('div');
    document.body.append(container, elsewhere);
    root = createRoot(container);
    await act(async () => root.render(createElement(WindowDragGrip)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    elsewhere.remove();
  });

  const grip = () => container.querySelector<HTMLElement>('.db-window-drag-grip')!;
  const tooltip = () => document.querySelector('.db-window-drag-grip-tooltip');
  const detectingHover = () => grip().classList.contains('db-window-drag-grip--detect-hover');

  async function pointer(target: Element, type: string, pointerType = 'mouse') {
    await act(async () => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType }));
    });
  }

  async function settle(ms: number) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  it('starts as a drag region and yields to the page once the pointer moves elsewhere', async () => {
    expect(detectingHover()).to.equal(false);
    await pointer(elsewhere, 'pointermove');
    expect(detectingHover()).to.equal(true);
  });

  it('re-arms on arrival, shows its hint, and closes it on movement elsewhere', async () => {
    await pointer(elsewhere, 'pointermove');
    await pointer(grip(), 'pointerover');
    // The arrival's own move lands on the grip and must not disarm it.
    await pointer(grip(), 'pointermove');
    expect(detectingHover()).to.equal(false);
    expect(tooltip()).to.equal(null);

    await settle(250);
    expect(tooltip()?.textContent).to.equal(WINDOW_DRAG_GRIP_TOOLTIP);
    expect(tooltip()?.getAttribute('aria-hidden')).to.equal('true');

    await pointer(elsewhere, 'pointermove');
    expect(tooltip()).to.equal(null);
    expect(detectingHover()).to.equal(true);
  });

  it('cancels a pending hint when the pointer moves on before the delay', async () => {
    await pointer(elsewhere, 'pointermove');
    await pointer(grip(), 'pointerover');
    await pointer(elsewhere, 'pointermove');
    await settle(250);
    expect(tooltip()).to.equal(null);
  });

  it('closes the hint when the window loses focus', async () => {
    await pointer(elsewhere, 'pointermove');
    await pointer(grip(), 'pointerover');
    await settle(250);
    expect(tooltip()).not.to.equal(null);
    await act(async () => window.dispatchEvent(new Event('blur')));
    expect(tooltip()).to.equal(null);
  });

  it('ignores touch, which never hovers', async () => {
    await pointer(elsewhere, 'pointermove', 'touch');
    expect(detectingHover()).to.equal(false);
    await pointer(elsewhere, 'pointermove');
    await pointer(grip(), 'pointerover', 'touch');
    await settle(250);
    expect(tooltip()).to.equal(null);
    expect(detectingHover()).to.equal(true);
  });
});
