/**
 * Shared WAI-ARIA menu-button keyboard contract.
 *
 * Escape is listened for at document scope so pointer-opened menus also
 * dismiss reliably when focus remains on their trigger.
 */
import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';

export interface MenuKeyboard {
  menuRef: RefObject<HTMLDivElement>;
  triggerRef: RefObject<HTMLButtonElement>;
  handleMenuKeyDown: (event: ReactKeyboardEvent) => void;
  handleTriggerKeyDown: (event: ReactKeyboardEvent) => void;
  closeMenu: (returnFocus: boolean) => void;
}

export function useMenuKeyboard(open: boolean, setOpen: (open: boolean) => void): MenuKeyboard {
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
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
      if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
    },
    [setOpen],
  );

  useEffect(() => {
    if (!open || pendingFocusRef.current === 'none') return;
    const where = pendingFocusRef.current;
    pendingFocusRef.current = 'none';
    focusItem(where === 'last' ? items().length - 1 : 0);
  }, [open, focusItem, items]);

  useEffect(() => {
    if (!open) return;
    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    };
    document.addEventListener('keydown', handleDocumentKeyDown);
    return () => document.removeEventListener('keydown', handleDocumentKeyDown);
  }, [closeMenu, open]);

  const handleTriggerKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        pendingFocusRef.current = event.key === 'ArrowUp' ? 'last' : 'first';
        setOpen(true);
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        if (!open) pendingFocusRef.current = 'first';
      }
    },
    [open, setOpen],
  );

  const handleMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        return;
      }
      if (event.key === 'Tab') {
        closeMenu(false);
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
