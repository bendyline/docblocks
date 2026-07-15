/**
 * Dialog — shared modal primitive.
 *
 * Promotes the `db-dialog-overlay` / `db-dialog` pattern used by the
 * settings dialogs into a reusable component, adding aria-modal and
 * initial focus. Escape and (by default) backdrop clicks close it.
 */

import React, { useCallback, useEffect, useId, useRef } from 'react';

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
  /** Additional class on the dialog panel. */
  className?: string;
  /** Additional class on the dialog body. */
  bodyClassName?: string;
  /** Additional class on the footer wrapper. */
  footerClassName?: string;
}

export function Dialog({
  title,
  onClose,
  size = 'default',
  children,
  footer,
  initialFocusRef,
  closeOnBackdrop = true,
  className,
  bodyClassName,
  footerClassName,
}: DialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) =>
          !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true',
      );
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = initialFocusRef?.current ?? closeButtonRef.current;
    target?.focus();
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    };
    // Focus only on mount — refocusing on every re-render would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (closeOnBackdrop && e.target === e.currentTarget) onClose();
    },
    [closeOnBackdrop, onClose],
  );

  const sizeClass = size === 'wide' ? 'db-dialog--wide' : size === 'full' ? 'db-dialog--full' : '';
  const panelClassName = ['db-dialog', sizeClass, className].filter(Boolean).join(' ');
  const bodyClasses = ['db-dialog-body', bodyClassName].filter(Boolean).join(' ');
  const footerClasses = ['db-dialog-footer', footerClassName].filter(Boolean).join(' ');

  return (
    <div className="db-dialog-overlay" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className={panelClassName}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="db-dialog-header">
          <h2 id={titleId} className="db-dialog-title">
            {title}
          </h2>
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
        <div className={bodyClasses}>{children}</div>
        {footer && <div className={footerClasses}>{footer}</div>}
      </div>
    </div>
  );
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[tabindex]:not([tabindex="-1"])',
].join(',');
