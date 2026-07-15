/**
 * usePromptDialog — an `await`-able, in-product replacement for the native
 * `window.prompt()`.
 *
 * Electron's renderer does not implement `window.prompt()` (it throws
 * "prompt() is and will not be supported"), so any shell action that asked for
 * a single line of text that way was dead on the desktop app. This hook gives
 * those call sites the same shape on top of the focus-trapped `Dialog`.
 *
 * The contract callers depend on:
 *   • resolves to the entered string, or `null` when the user cancels
 *   • it *always* resolves — superseding a prompt or unmounting the host
 *     settles the outstanding promise as a cancel rather than stranding a
 *     caller in an `await` that nobody will ever answer
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PromptDialog, type PromptRequest } from './PromptDialog.js';

interface PendingPrompt {
  id: number;
  request: PromptRequest;
  settle: (value: string | null) => void;
}

export interface PromptDialogController {
  /** Ask the user for a line of text. Resolves `null` if they cancel. */
  prompt: (request: PromptRequest) => Promise<string | null>;
  /** Render this somewhere in the host's tree. */
  promptDialog: React.ReactNode;
}

export function usePromptDialog(): PromptDialogController {
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const pendingRef = useRef<PendingPrompt | null>(null);
  const nextIdRef = useRef(0);

  /**
   * The single exit for an open prompt. Submit, cancel, supersede and unmount
   * all funnel through here, which is what guarantees no caller is left
   * awaiting a promise nobody settles. Settling twice is a no-op.
   */
  const settlePending = useCallback((value: string | null) => {
    const current = pendingRef.current;
    if (!current) return;
    pendingRef.current = null;
    setPending((open) => (open?.id === current.id ? null : open));
    current.settle(value);
  }, []);

  const prompt = useCallback(
    (request: PromptRequest) =>
      new Promise<string | null>((resolve) => {
        // A newer prompt replaces the older one; the superseded caller sees a
        // cancel rather than a promise that outlives its dialog.
        settlePending(null);
        const next: PendingPrompt = { id: ++nextIdRef.current, request, settle: resolve };
        pendingRef.current = next;
        setPending(next);
      }),
    [settlePending],
  );

  useEffect(() => {
    // Unmounting the shell must not strand a caller mid-await.
    return () => settlePending(null);
  }, [settlePending]);

  const promptDialog = pending
    ? React.createElement(PromptDialog, {
        // Remount on a superseding request so the field re-seeds from it.
        key: pending.id,
        request: pending.request,
        onSettle: settlePending,
      })
    : null;

  return { prompt, promptDialog };
}
