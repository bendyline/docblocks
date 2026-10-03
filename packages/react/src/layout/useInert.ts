import { useEffect, type RefObject } from 'react';

/**
 * Toggle the `inert` attribute on an element.
 *
 * Applied from an effect rather than as a JSX prop on purpose: React 18 and 19
 * disagree about whether `inert` is a typed DOM prop, and going through
 * `toggleAttribute` sidesteps that without an `any` or a module augmentation.
 *
 * `inert` is also strictly better than a hand-rolled Tab cycle for containing
 * focus in the drawer — the browser removes the subtree from the tab order,
 * from the accessibility tree, and from pointer hit-testing, and it correctly
 * handles content that appears while the pane is hidden.
 */
export function useInert(ref: RefObject<HTMLElement | null>, inert: boolean): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.toggleAttribute('inert', inert);
    return () => element.removeAttribute('inert');
  }, [ref, inert]);
}
