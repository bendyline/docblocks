import { useEffect, useMemo, useState, type RefObject } from 'react';
import {
  classifyFormFactor,
  type DbHover,
  type DbPointer,
  type FormFactor,
  type FormFactorInput,
} from './form-factor.js';
import { isInstalledDisplayMode, useMediaQuery } from './useMediaQuery.js';

const COARSE_POINTER_QUERY = '(pointer: coarse)';
/**
 * `any-hover`, not `hover`. An iPad with a Magic Keyboard reports
 * `(pointer: coarse)` AND `(any-hover: hover)`; using the pair is what lets it
 * keep 44px touch targets while regaining hover-reveal affordances. `(hover:
 * hover)` alone reports the *primary* input and would deny it one or the other.
 */
const ANY_HOVER_QUERY = '(any-hover: hover)';

interface Size {
  readonly width: number;
  readonly height: number;
}

function initialSize(): Size {
  if (typeof window === 'undefined') return { width: 1280, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Classify the shell's own box, not the window.
 *
 * Measuring the element is what makes this correct under iPad Stage Manager, a
 * split-screen Android window, and any embedded mount — all cases where
 * `window.innerWidth` describes something other than the space the shell has.
 * It also makes the E2E suite deterministic.
 *
 * `override` exists for hosts that know better than the DOM (a Capacitor shell
 * reporting a native trait) and for tests.
 */
export function useFormFactor(
  rootRef: RefObject<HTMLElement | null>,
  override?: Partial<FormFactorInput>,
): FormFactor {
  const [size, setSize] = useState<Size>(initialSize);
  const coarse = useMediaQuery(COARSE_POINTER_QUERY);
  const anyHover = useMediaQuery(ANY_HOVER_QUERY);
  const [installed, setInstalled] = useState(isInstalledDisplayMode);

  useEffect(() => {
    const element = rootRef.current;
    const readWindow = (): void => setSize(initialSize());

    if (!element || typeof ResizeObserver === 'undefined') {
      readWindow();
      if (typeof window === 'undefined') return;
      window.addEventListener('resize', readWindow);
      return () => window.removeEventListener('resize', readWindow);
    }

    const measure = (): void => {
      const rect = element.getBoundingClientRect();
      // A detached or display:none shell measures 0x0. Fall back to the window
      // rather than classifying the app as an impossibly small phone.
      if (rect.width <= 0 || rect.height <= 0) {
        readWindow();
        return;
      }
      setSize((previous) =>
        previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [rootRef]);

  // Installed-ness can change mid-session when a PWA is installed.
  useEffect(() => {
    if (typeof globalThis.matchMedia !== 'function') return;
    const update = (): void => setInstalled(isInstalledDisplayMode());
    const lists = ['(display-mode: window-controls-overlay)', '(display-mode: standalone)'].map(
      (query) => globalThis.matchMedia(query),
    );
    for (const list of lists) list.addEventListener('change', update);
    return () => {
      for (const list of lists) list.removeEventListener('change', update);
    };
  }, []);

  const pointer: DbPointer = coarse ? 'coarse' : 'fine';
  const hover: DbHover = anyHover ? 'hover' : 'none';

  return useMemo(
    () =>
      classifyFormFactor({
        width: size.width,
        height: size.height,
        pointer,
        hover,
        installed,
        ...override,
      }),
    [size.width, size.height, pointer, hover, installed, override],
  );
}
