import { useEffect, useRef } from 'react';
import type { DbLayoutMode } from '../layout/form-factor.js';
import { matchShortcut, type ShellShortcutId } from './keyboard-shortcuts.js';

export type ShellShortcutHandlers = Partial<Record<ShellShortcutId, () => void>>;

/**
 * Install one capture-phase listener for every shell shortcut.
 *
 * Capture phase so the shell sees the event before Squisq or Monaco can
 * swallow it, and `stopPropagation` only for a binding that actually matched —
 * an unmatched key must reach the editor untouched.
 *
 * Presence of a handler IS the claim. A caller that only sometimes wants a key
 * must omit the handler the rest of the time rather than no-op inside it;
 * otherwise the event is swallowed from whatever would have handled it next.
 * That is why `close-overlay` is registered only while the drawer is open.
 *
 * Handlers are held in a ref so a changing handler identity never re-installs
 * the listener; a re-install between keydown and keyup drops the shortcut.
 */
export function useShellShortcuts(handlers: ShellShortcutHandlers, layoutMode: DbLayoutMode): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onKeyDown = (event: KeyboardEvent): void => {
      const id = matchShortcut(event, layoutMode);
      if (!id) return;
      const handler = handlersRef.current[id];
      if (!handler) return;
      event.preventDefault();
      event.stopPropagation();
      handler();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [layoutMode]);
}
