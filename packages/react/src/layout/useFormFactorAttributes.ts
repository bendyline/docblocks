import { useEffect, type RefObject } from 'react';
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
    const names = Object.keys(attributes);

    for (const target of targets) {
      for (const [name, value] of Object.entries(attributes)) {
        if (target.getAttribute(name) !== value) target.setAttribute(name, value);
      }
      if (layoutMode !== 'single-pane' && target.hasAttribute('data-db-drawer')) {
        target.removeAttribute('data-db-drawer');
      }
    }

    return () => {
      for (const target of targets) {
        for (const name of names) target.removeAttribute(name);
        target.removeAttribute('data-db-drawer');
      }
    };
  }, [rootRef, formFactor, layoutMode, drawerOpen]);
}
