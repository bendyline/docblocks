/**
 * useMenuKeyboard — the WAI-ARIA menu-button key contract for a trigger +
 * `role="menu"` dropdown pair.
 *
 *   Trigger: ArrowDown / ArrowUp / Enter / Space open the menu and focus
 *            its first (or last) item.
 *   Menu:    ArrowDown/ArrowUp cycle, Home/End jump, Escape closes and
 *            returns focus to the trigger, Tab closes.
 *
 * Items are not tab stops (`tabIndex={-1}`); the trigger is the single tab
 * stop, and focus moves within the menu by arrow key.
 *
 * NOTE: five dropdowns in this package share this contract — the two git
 * ones (which use this), plus AppMenu, ExportToolbarControls and
 * WorkspaceSettingsButton, which are owned elsewhere and still lack it.
 * This hook lives under Git/ only because that is the scope it was written
 * in; it has no git dependency and should be lifted to a shared location
 * and applied to the other three.
 */

import { useCallback, useEffect, useRef } from 'react';

export interface MenuKeyboard {
  /** Attach to the `role="menu"` element. */
  menuRef: React.RefObject<HTMLDivElement>;
  /** Attach to the button that opens the menu. */
  triggerRef: React.RefObject<HTMLButtonElement>;
  handleMenuKeyDown: (event: React.KeyboardEvent) => void;
  handleTriggerKeyDown: (event: React.KeyboardEvent) => void;
  /** Close from a click handler without stealing focus back. */
  closeMenu: (returnFocus: boolean) => void;
}

export function useMenuKeyboard(open: boolean, setOpen: (open: boolean) => void): MenuKeyboard {
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** Where to land when the menu opens: keyboard users must go inside it. */
  const pendingFocusRef = useRef<'none' | 'first' | 'last'>('none');

  const items = useCallback(
    () =>
      [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])].filter(
        (item) => !item.disabled,
      ),
    [],
  );

  const focusItem = useCallback(
    (index: number) => {
      const all = items();
      if (all.length === 0) return;
      all[((index % all.length) + all.length) % all.length]?.focus({ preventScroll: true });
    },
    [items],
  );

  const closeMenu = useCallback(
    (returnFocus: boolean) => {
      pendingFocusRef.current = 'none';
      setOpen(false);
      if (returnFocus) triggerRef.current?.focus();
    },
    [setOpen],
  );

  // Land inside the menu once it has rendered, but only when the keyboard
  // opened it — a pointer user's focus should stay where they clicked.
  useEffect(() => {
    if (!open || pendingFocusRef.current === 'none') return;
    const where = pendingFocusRef.current;
    pendingFocusRef.current = 'none';
    focusItem(where === 'last' ? items().length - 1 : 0);
  }, [open, focusItem, items]);

  const handleTriggerKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        pendingFocusRef.current = event.key === 'ArrowUp' ? 'last' : 'first';
        setOpen(true);
        return;
      }
      // Enter/Space already activate the button (which toggles the menu);
      // this only says where focus should land when they do.
      if (event.key === 'Enter' || event.key === ' ') {
        if (!open) pendingFocusRef.current = 'first';
      }
    },
    [open, setOpen],
  );

  const handleMenuKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        return;
      }
      const all = items();
      if (all.length === 0) return;
      const current = all.indexOf(document.activeElement as HTMLButtonElement);
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          focusItem(current + 1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          focusItem(current - 1);
          break;
        case 'Home':
          event.preventDefault();
          focusItem(0);
          break;
        case 'End':
          event.preventDefault();
          focusItem(all.length - 1);
          break;
        default:
          break;
      }
    },
    [closeMenu, focusItem, items],
  );

  return { menuRef, triggerRef, handleMenuKeyDown, handleTriggerKeyDown, closeMenu };
}
