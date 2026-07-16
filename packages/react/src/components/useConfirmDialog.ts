/**
 * useConfirmDialog — `await`-able, in-product replacements for the native
 * `window.confirm()` and `window.alert()`.
 *
 * Both natives block the renderer, look nothing like the product, and title
 * themselves with the browser's or Electron's name. This hook gives those call
 * sites the same shape on top of the focus-trapped `Dialog`.
 *
 * The contract callers depend on (identical to `usePromptDialog`'s):
 *   • `confirm` resolves `true` when accepted, `false` when cancelled
 *   • `acknowledge` resolves once the user dismisses the message
 *   • it *always* resolves — superseding a dialog or unmounting the host
 *     settles the outstanding promise as a cancel rather than stranding a
 *     caller in an `await` that nobody will ever answer
 *
 * Callers that convert a synchronous `confirm()` into an `await` gain a
 * suspension point the original did not have: re-check any request-id fence
 * *after* awaiting, not before.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ConfirmDialog,
  type AcknowledgeRequest,
  type ConfirmDialogRequest,
  type ConfirmRequest,
} from './ConfirmDialog.js';

interface PendingConfirm {
  id: number;
  request: ConfirmDialogRequest;
  settle: (value: boolean) => void;
}

export interface ConfirmDialogController {
  /** Ask the user a yes/no question. Resolves `false` if they cancel. */
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  /** Show a message the user must dismiss. Resolves once it is dismissed. */
  acknowledge: (request: AcknowledgeRequest) => Promise<void>;
  /** Render this somewhere in the host's tree. */
  confirmDialog: React.ReactNode;
}

export function useConfirmDialog(): ConfirmDialogController {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);
  const nextIdRef = useRef(0);

  /**
   * The single exit for an open dialog. Accept, cancel, supersede and unmount
   * all funnel through here, which is what guarantees no caller is left
   * awaiting a promise nobody settles. Settling twice is a no-op.
   */
  const settlePending = useCallback((value: boolean) => {
    const current = pendingRef.current;
    if (!current) return;
    pendingRef.current = null;
    setPending((open) => (open?.id === current.id ? null : open));
    current.settle(value);
  }, []);

  const open = useCallback(
    (request: ConfirmDialogRequest) =>
      new Promise<boolean>((resolve) => {
        // A newer dialog replaces the older one; the superseded caller sees a
        // cancel rather than a promise that outlives its dialog.
        settlePending(false);
        const next: PendingConfirm = { id: ++nextIdRef.current, request, settle: resolve };
        pendingRef.current = next;
        setPending(next);
      }),
    [settlePending],
  );

  const confirm = useCallback(
    (request: ConfirmRequest) => open({ kind: 'confirm', ...request }),
    [open],
  );

  const acknowledge = useCallback(
    async (request: AcknowledgeRequest) => {
      // The resolved value carries no information for an acknowledgement --
      // dismissed and unmounted are the same outcome to every caller.
      await open({ kind: 'acknowledge', ...request });
    },
    [open],
  );

  useEffect(() => {
    // Unmounting the shell must not strand a caller mid-await.
    return () => settlePending(false);
  }, [settlePending]);

  const confirmDialog = pending
    ? React.createElement(ConfirmDialog, {
        // Remount on a superseding request so focus re-seeds from it.
        key: pending.id,
        request: pending.request,
        onSettle: settlePending,
      })
    : null;

  return { confirm, acknowledge, confirmDialog };
}
