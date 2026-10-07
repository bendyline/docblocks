import { expect } from 'chai';
import { useLongPress } from '../src/FileExplorer/useLongPress.js';
import { act, advanceTime, renderHook } from './helpers/renderHook.js';

interface PointerInit {
  pointerType?: string;
  isPrimary?: boolean;
  clientX?: number;
  clientY?: number;
}

function pointer({ pointerType, isPrimary, clientX, clientY }: PointerInit = {}) {
  return {
    pointerType: pointerType ?? 'touch',
    isPrimary: isPrimary ?? true,
    clientX: clientX ?? 40,
    clientY: clientY ?? 80,
  } as unknown as React.PointerEvent;
}

function countScrollListeners(): number {
  // happy-dom does not expose listener counts, so instrument the document.
  return scrollListenerCount;
}

let scrollListenerCount = 0;
let originalAdd: typeof document.addEventListener;
let originalRemove: typeof document.removeEventListener;

beforeEach(() => {
  scrollListenerCount = 0;
  originalAdd = document.addEventListener.bind(document);
  originalRemove = document.removeEventListener.bind(document);
  document.addEventListener = ((type: string, listener: EventListener, options?: unknown) => {
    if (type === 'scroll') scrollListenerCount += 1;
    return originalAdd(type, listener, options as AddEventListenerOptions);
  }) as typeof document.addEventListener;
  document.removeEventListener = ((type: string, listener: EventListener, options?: unknown) => {
    if (type === 'scroll') scrollListenerCount -= 1;
    return originalRemove(type, listener, options as AddEventListenerOptions);
  }) as typeof document.removeEventListener;
});

afterEach(() => {
  document.addEventListener = originalAdd;
  document.removeEventListener = originalRemove;
});

describe('useLongPress', () => {
  it('fires after the hold and reports the press coordinates', async () => {
    const fired: Array<{ x: number; y: number }> = [];
    const hook = await renderHook(() => useLongPress((point) => fired.push(point)), undefined);

    await act(async () => {
      hook.result.current.handlers.onPointerDown(pointer({ clientX: 120, clientY: 240 }));
    });
    expect(fired).to.deep.equal([]);

    await advanceTime(600);
    expect(fired).to.deep.equal([{ x: 120, y: 240 }]);
    await hook.unmount();
  });

  it('ignores a mouse press so the native context menu still works', async () => {
    let fired = 0;
    const hook = await renderHook(() => useLongPress(() => (fired += 1)), undefined);
    await act(async () => {
      hook.result.current.handlers.onPointerDown(pointer({ pointerType: 'mouse' }));
    });
    await advanceTime(600);
    expect(fired).to.equal(0);
    await hook.unmount();
  });

  it('cancels when the finger moves past the slop, i.e. a scroll', async () => {
    let fired = 0;
    const hook = await renderHook(() => useLongPress(() => (fired += 1)), undefined);
    await act(async () => {
      hook.result.current.handlers.onPointerDown(pointer({ clientX: 40, clientY: 80 }));
      hook.result.current.handlers.onPointerMove(pointer({ clientX: 40, clientY: 120 }));
    });
    await advanceTime(600);
    expect(fired).to.equal(0);
    await hook.unmount();
  });

  it('cancels on pointerup before the hold completes', async () => {
    let fired = 0;
    const hook = await renderHook(() => useLongPress(() => (fired += 1)), undefined);
    await act(async () => {
      hook.result.current.handlers.onPointerDown(pointer());
      hook.result.current.handlers.onPointerUp(pointer());
    });
    await advanceTime(600);
    expect(fired).to.equal(0);
    await hook.unmount();
  });

  it('holds a document scroll listener only while a press is pending', async () => {
    // A tree renders one of these per row; a listener kept for the component
    // lifetime would mean hundreds of permanent document-level listeners.
    const hook = await renderHook(() => useLongPress(() => undefined), undefined);
    expect(countScrollListeners()).to.equal(0);

    await act(async () => {
      hook.result.current.handlers.onPointerDown(pointer());
    });
    expect(countScrollListeners()).to.equal(1);

    await act(async () => {
      hook.result.current.handlers.onPointerUp(pointer());
    });
    expect(countScrollListeners()).to.equal(0);

    await hook.unmount();
    expect(countScrollListeners()).to.equal(0);
  });

  it('swallows the synthetic contextmenu Android fires after its own long press', async () => {
    const hook = await renderHook(() => useLongPress(() => undefined), undefined);
    expect(hook.result.current.shouldIgnoreContextMenu()).to.equal(false);

    await act(async () => {
      hook.result.current.handlers.onPointerDown(pointer());
    });
    await advanceTime(600);
    expect(hook.result.current.shouldIgnoreContextMenu()).to.equal(true);
    await hook.unmount();
  });
});
