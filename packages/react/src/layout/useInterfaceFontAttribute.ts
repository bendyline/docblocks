import { useEffect } from 'react';
import type { InterfaceFontPreference } from '../preferences/theme.js';

/** Root attribute the chrome font rules key off. */
export const INTERFACE_FONT_ATTRIBUTE = 'data-db-interface-font';

/**
 * Publish the interface-font choice on `document.documentElement`.
 *
 * On the root rather than the shell because Squisq portals its menus and
 * dialogs onto `<body>`, outside `.db-shell` — the same reason the form-factor
 * attributes and the `--db-*` palette are bound there. A portaled menu that
 * kept `system-ui` while the shell switched would defeat the point.
 *
 * `system` is the default and removes the attribute rather than stamping a
 * value, so the untouched state is the native one.
 */
export function useInterfaceFontAttribute(preference: InterfaceFontPreference): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;

    if (preference !== 'fixed') {
      root.removeAttribute(INTERFACE_FONT_ATTRIBUTE);
      return;
    }

    root.setAttribute(INTERFACE_FONT_ATTRIBUTE, 'fixed');
    return () => root.removeAttribute(INTERFACE_FONT_ATTRIBUTE);
  }, [preference]);
}
