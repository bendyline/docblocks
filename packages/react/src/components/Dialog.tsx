/**
 * Dialog — shared modal primitive.
 *
 * Promotes the `db-dialog-overlay` / `db-dialog` pattern used by the
 * settings dialogs into a reusable component, adding aria-modal and
 * initial focus. Escape and (by default) backdrop clicks close it.
 */

import { useCallback, useEffect, useRef } from 'react';

export interface DialogProps {
  title: string;
  onClose: () => void;
  /** default 380px / wide 560px / full min(1100px, 94vw) column. */
  size?: 'default' | 'wide' | 'full';
  children: React.ReactNode;
  /** Right-aligned action row below the body. */
  footer?: React.ReactNode;
  /** Element to focus on open; defaults to the close button. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** Set false when a stray backdrop click would lose user input. */
  closeOnBackdrop?: boolean;
}

export function Dialog({
  title,
  onClose,
  size = 'default',
  children,
  footer,
  initialFocusRef,
  closeOnBackdrop = true,
}: DialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const target = initialFocusRef?.current ?? closeButtonRef.current;
    target?.focus();
    // Focus only on mount — refocusing on every re-render would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (closeOnBackdrop && e.target === e.currentTarget) onClose();
    },
    [closeOnBackdrop, onClose],
  );

  const sizeClass =
    size === 'wide' ? ' db-dialog--wide' : size === 'full' ? ' db-dialog--full' : '';

  return (
    <div className="db-dialog-overlay" onClick={handleBackdropClick}>
      <div className={`db-dialog${sizeClass}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="db-dialog-header">
          <h2 className="db-dialog-title">{title}</h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="db-dialog-close"
            onClick={onClose}
            aria-label="Close"
          >
            &times;
          </button>
        </div>
        <div className="db-dialog-body">{children}</div>
        {footer && <div className="db-dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}
