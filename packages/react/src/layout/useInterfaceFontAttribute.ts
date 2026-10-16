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
 * The bundled face is the default and removes the attribute rather than
 * stamping a value, so the untouched state — and every surface that never
 * mounts this hook, such as the VS Code webview — gets the stylesheet's own
 * default. Only the `system` opt-out is published.
 */
export function useInterfaceFontAttribute(preference: InterfaceFontPreference): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;

    if (preference !== 'system') {
      root.removeAttribute(INTERFACE_FONT_ATTRIBUTE);
      return;
    }

    root.setAttribute(INTERFACE_FONT_ATTRIBUTE, 'system');
    return () => root.removeAttribute(INTERFACE_FONT_ATTRIBUTE);
  }, [preference]);
}
