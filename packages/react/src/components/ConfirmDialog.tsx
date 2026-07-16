/**
 * ConfirmDialog — a yes/no question, or a message the user must acknowledge,
 * on the shared `Dialog` primitive.
 *
 * The product's replacement for `window.confirm()` and `window.alert()`. Both
 * natives block the renderer's event loop, ignore the app's theme and accent,
 * and stamp the browser/Electron chrome's name on a DocBlocks question — in a
 * shell that already ships a focus-trapped `Dialog` and a toast channel.
 *
 * Confirm and acknowledge share one component because an acknowledgement is a
 * confirm with the cancel path removed: same focus trap, same settle contract,
 * same footer. Callers drive it through `useConfirmDialog()`, which owns the
 * open/settle lifecycle; this component is only the view.
 */

import React, { useCallback, useRef } from 'react';
import { Dialog } from './Dialog.js';

export interface ConfirmRequest {
  /** Dialog heading, e.g. "Remove workspace". */
  title: string;
  /** The question. Rendered as plain text — no markup. */
  message: string;
  /** Confirm button text; defaults to "OK". */
  confirmLabel?: string;
  /** Cancel button text; defaults to "Cancel". */
  cancelLabel?: string;
  /**
   * Styles the confirm button as destructive and moves initial focus to
   * Cancel, so a reflexive Enter does not delete anything.
   */
  destructive?: boolean;
}

export interface AcknowledgeRequest {
  /** Dialog heading, e.g. "About DocBlocks". */
  title: string;
  /** The message. Rendered as plain text — no markup. */
  message: string;
  /** Dismiss button text; defaults to "OK". */
  confirmLabel?: string;
}

/**
 * `acknowledge` has no cancel path, so it carries neither a cancel label nor a
 * destructive treatment. The discriminant keeps those props off the shape that
 * cannot use them rather than documenting "ignored when …".
 */
export type ConfirmDialogRequest =
  | ({ kind: 'confirm' } & ConfirmRequest)
  | ({ kind: 'acknowledge' } & AcknowledgeRequest);

export interface ConfirmDialogProps {
  request: ConfirmDialogRequest;
  /**
   * Called exactly once. `true` when confirmed (or acknowledged), `false`
   * when the user cancels a confirm.
   */
  onSettle: (value: boolean) => void;
}

export function ConfirmDialog({ request, onSettle }: ConfirmDialogProps) {
  const acknowledge = request.kind === 'acknowledge';
  const destructive = request.kind === 'confirm' && request.destructive === true;

  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const accept = useCallback(() => onSettle(true), [onSettle]);
  const reject = useCallback(() => onSettle(false), [onSettle]);

  // Escape, the close button and a backdrop click are a dismissal. For a
  // question that means "no"; for an acknowledgement, dismissing *is* the
  // acknowledgement, so it settles the same way the OK button does.
  const close = acknowledge ? accept : reject;

  return (
    <Dialog
      title={request.title}
      onClose={close}
      // Focus the safe button. On a destructive confirm that is Cancel, so
      // muscle-memory Enter cannot destroy a workspace; everywhere else the
      // confirm button is both safe and the likely answer.
      initialFocusRef={destructive ? cancelRef : confirmRef}
      footer={
        <>
          {!acknowledge && (
            <button ref={cancelRef} type="button" className="db-git-secondary-btn" onClick={reject}>
              {request.cancelLabel ?? 'Cancel'}
            </button>
          )}
          <button
            ref={confirmRef}
            type="button"
            className={
              destructive ? 'db-git-primary-btn db-git-primary-btn--danger' : 'db-git-primary-btn'
            }
            onClick={accept}
          >
            {request.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      <p className="db-dialog-message">{request.message}</p>
    </Dialog>
  );
}
