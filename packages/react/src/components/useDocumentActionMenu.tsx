/**
 * A DocBlocks menu button (AI, speech, Git, export) as one of Squisq's
 * toolbar document actions.
 *
 * The controls render in `EditorShell`'s `toolbarSlotDocumentActions`, behind
 * the divider Squisq draws before its own Document settings. When the row
 * runs short Squisq folds the whole group into one "Document actions" menu,
 * and each control's row there drills into the control's own menu items.
 * This hook carries that contract for a control with an inline dropdown:
 * hide the trigger while folded, close the dropdown when the group folds,
 * portal the same items into the folded menu while it shows them, and close
 * whichever menu is showing when an item runs.
 *
 * Outside a Squisq toolbar (an image-mode header, a test) nothing folds and
 * the control behaves as a plain menu button.
 */

import { useCallback, useEffect, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  useToolbarDocumentAction,
  type ToolbarDocumentAction,
} from '@bendyline/squisq-editor-react';

export interface DocumentActionMenu {
  /** Squisq folded the document actions: render no trigger of your own. */
  readonly folded: boolean;
  /** The control's items are on screen, in its own dropdown or the folded menu. */
  readonly itemsShown: boolean;
  /** Close whichever menu shows the items; `returnFocus` refocuses its trigger. */
  readonly closeMenu: (returnFocus: boolean) => void;
  /** The items, portaled into the folded menu while it shows them; otherwise null. */
  readonly foldedItems: (items: ReactNode, className?: string) => ReactNode;
}

/**
 * @param action - the control's row in the folded menu, or null for none
 *   (the control renders nothing).
 * @param rootRef - the control's root, which orders its row among the others.
 * @param closeInlineMenu - the control's own dropdown close, e.g. from
 *   `useMenuKeyboard`.
 */
export function useDocumentActionMenu(
  action: ToolbarDocumentAction | null,
  rootRef: RefObject<HTMLElement | null>,
  menuOpen: boolean,
  setMenuOpen: (open: boolean) => void,
  closeInlineMenu: (returnFocus: boolean) => void,
): DocumentActionMenu {
  const {
    folded,
    submenuContainer,
    closeMenu: closeFoldedMenu,
  } = useToolbarDocumentAction(action, rootRef);

  // The trigger the dropdown hangs from is about to disappear.
  useEffect(() => {
    if (folded) setMenuOpen(false);
  }, [folded, setMenuOpen]);

  const closeMenu = useCallback(
    (returnFocus: boolean) => {
      if (submenuContainer) closeFoldedMenu(returnFocus);
      else closeInlineMenu(returnFocus);
    },
    [submenuContainer, closeFoldedMenu, closeInlineMenu],
  );

  const foldedItems = useCallback(
    (items: ReactNode, className?: string) =>
      submenuContainer
        ? createPortal(
            <div
              role="none"
              className={`db-document-action-items${className ? ` ${className}` : ''}`}
            >
              {items}
            </div>,
            submenuContainer,
          )
        : null,
    [submenuContainer],
  );

  return { folded, itemsShown: menuOpen || submenuContainer !== null, closeMenu, foldedItems };
}
