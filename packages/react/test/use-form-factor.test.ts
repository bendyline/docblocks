import { expect } from 'chai';
import { createRef } from 'react';
import { useFormFactor } from '../src/layout/useFormFactor.js';
import { useMediaQuery } from '../src/layout/useMediaQuery.js';
import { act, renderHook } from './helpers/renderHook.js';

interface FakeMedia {
  setMatches(query: string, matches: boolean): Promise<void>;
  activeListenerCount(): number;
  restore(): void;
}

function installFakeMatchMedia(initial: Readonly<Record<string, boolean>>): FakeMedia {
  const original = globalThis.matchMedia;
  const state = new Map(Object.entries(initial));
  const listeners = new Map<string, Set<() => void>>();

  globalThis.matchMedia = ((query: string) =>
    ({
      get matches() {
        return state.get(query) ?? false;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => {
        const set = listeners.get(query) ?? new Set();
        set.add(listener);
        listeners.set(query, set);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.get(query)?.delete(listener);
      },
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }) satisfies MediaQueryList) as typeof globalThis.matchMedia;

  return {
    async setMatches(query, matches) {
      state.set(query, matches);
      await act(async () => {
        for (const listener of listeners.get(query) ?? []) listener();
      });
    },
    activeListenerCount() {
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
    restore() {
      globalThis.matchMedia = original;
    },
  };
}

/** A ref to an element whose measured box we control. */
function sizedRef(width: number, height: number) {
  const element = document.createElement('div');
  let box = { width, height };
  element.getBoundingClientRect = (() =>
    ({
      width: box.width,
      height: box.height,
      top: 0,
      left: 0,
      right: box.width,
      bottom: box.height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect) as HTMLElement['getBoundingClientRect'];
  const ref = createRef<HTMLElement>() as { current: HTMLElement | null };
  ref.current = element;
  return {
    ref,
    resize(next: { width: number; height: number }) {
      box = next;
    },
  };
}

describe('useMediaQuery', () => {
  it('reports the initial match and tracks live changes', async () => {
    const media = installFakeMatchMedia({ '(pointer: coarse)': false });
    try {
      const hook = await renderHook(() => useMediaQuery('(pointer: coarse)'), undefined);
      expect(hook.result.current).to.equal(false);

      await media.setMatches('(pointer: coarse)', true);
      expect(hook.result.current).to.equal(true);

      await hook.unmount();
      expect(media.activeListenerCount()).to.equal(0);
    } finally {
      media.restore();
    }
  });

  it('reports false rather than throwing when matchMedia is unavailable', async () => {
    const original = globalThis.matchMedia;
    // @ts-expect-error deliberately removing the API to model a non-browser host
    delete globalThis.matchMedia;
    try {
      const hook = await renderHook(() => useMediaQuery('(pointer: coarse)'), undefined);
      expect(hook.result.current).to.equal(false);
      await hook.unmount();
    } finally {
      globalThis.matchMedia = original;
    }
  });
});

describe('useFormFactor', () => {
  it('classifies from the measured element, not the window', async () => {
    const media = installFakeMatchMedia({
      '(pointer: coarse)': true,
      '(any-hover: hover)': false,
    });
    const { ref } = sizedRef(390, 844);
    try {
      const hook = await renderHook(() => useFormFactor(ref), undefined);
      expect(hook.result.current.width).to.equal(390);
      expect(hook.result.current.widthClass).to.equal('compact');
      expect(hook.result.current.formFactor).to.equal('phone');
      expect(hook.result.current.splitPaneAllowed).to.equal(false);
      await hook.unmount();
    } finally {
      media.restore();
    }
  });

  it('separates a coarse pointer from hover capability', async () => {
    // The iPad-with-Magic-Keyboard case: attaching the keyboard must flip
    // hover without touching the pointer classification.
    const media = installFakeMatchMedia({
      '(pointer: coarse)': true,
      '(any-hover: hover)': false,
    });
    const { ref } = sizedRef(1194, 834);
    try {
      const hook = await renderHook(() => useFormFactor(ref), undefined);
      expect(hook.result.current.pointer).to.equal('coarse');
      expect(hook.result.current.hover).to.equal('none');
      expect(hook.result.current.formFactor).to.equal('tablet-landscape');

      await media.setMatches('(any-hover: hover)', true);
      expect(hook.result.current.pointer).to.equal('coarse');
      expect(hook.result.current.hover).to.equal('hover');
      expect(hook.result.current.formFactor).to.equal('tablet-landscape');

      await hook.unmount();
    } finally {
      media.restore();
    }
  });

  it('lets a host override the detected traits', async () => {
    const media = installFakeMatchMedia({ '(pointer: coarse)': false });
    const { ref } = sizedRef(1280, 800);
    try {
      const override = { pointer: 'coarse' } as const;
      const hook = await renderHook(() => useFormFactor(ref, override), undefined);
      expect(hook.result.current.pointer).to.equal('coarse');
      expect(hook.result.current.formFactor).to.equal('tablet-landscape');
      await hook.unmount();
    } finally {
      media.restore();
    }
  });

  it('removes every media listener on unmount', async () => {
    const media = installFakeMatchMedia({
      '(pointer: coarse)': false,
      '(any-hover: hover)': true,
    });
    const { ref } = sizedRef(1280, 800);
    try {
      const hook = await renderHook(() => useFormFactor(ref), undefined);
      expect(media.activeListenerCount()).to.be.greaterThan(0);
      await hook.unmount();
      expect(media.activeListenerCount()).to.equal(0);
    } finally {
      media.restore();
    }
  });

  it('falls back to the window when the element measures zero', async () => {
    const media = installFakeMatchMedia({ '(pointer: coarse)': false });
    const { ref } = sizedRef(0, 0);
    try {
      const hook = await renderHook(() => useFormFactor(ref), undefined);
      // happy-dom reports a non-zero default window size; the point is that a
      // detached shell is never classified as a 0px phone.
      expect(hook.result.current.width).to.be.greaterThan(0);
      await hook.unmount();
    } finally {
      media.restore();
    }
  });
});
