import { useEffect, useRef, type RefObject } from 'react';
import { formFactorDataAttributes, type DbLayoutMode, type FormFactor } from './form-factor.js';

/**
 * Publish the resolved form factor as `data-db-*` attributes.
 *
 * Stamped on `document.documentElement` as well as the shell root because
 * Squisq portals its menus and dialogs onto `<body>`, outside the shell — the
 * same reason the `--db-*` palette is bound on `:root` rather than only on
 * `.db-shell`.
 *
 * Attributes are written only when they change so the MutationObservers that
 * Squisq and Monaco install do not churn on every resize frame.
 */
export function useFormFactorAttributes(
  rootRef: RefObject<HTMLElement | null>,
  formFactor: FormFactor,
  layoutMode: DbLayoutMode,
  drawerOpen: boolean,
): void {
  const published = useRef(new Map<HTMLElement, Set<string>>());

  // Cleanup belongs to the hook lifetime, not each measured size. Removing
  // every trait between resize events wakes editor observers even when the
  // form-factor classification has not changed.
  useEffect(() => {
    const owned = published.current;
    return () => {
      for (const [target, names] of owned) {
        for (const name of names) target.removeAttribute(name);
      }
      owned.clear();
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const attributes: Record<string, string> = {
      ...formFactorDataAttributes(formFactor, layoutMode),
    };
    // Only meaningful while one pane is hidden behind the other.
    if (layoutMode === 'single-pane') {
      attributes['data-db-drawer'] = drawerOpen ? 'open' : 'closed';
    }

    const targets = [document.documentElement, rootRef.current].filter(
      (node): node is HTMLElement => node !== null,
    );
    for (const target of targets) {
      const names = published.current.get(target) ?? new Set<string>();
      published.current.set(target, names);
      for (const [name, value] of Object.entries(attributes)) {
        names.add(name);
        if (target.getAttribute(name) !== value) target.setAttribute(name, value);
      }
      if (layoutMode !== 'single-pane' && target.hasAttribute('data-db-drawer')) {
        target.removeAttribute('data-db-drawer');
      }
    }
  }, [rootRef, formFactor, layoutMode, drawerOpen]);
}
