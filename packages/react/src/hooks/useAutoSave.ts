/**
 * useAutoSave — debounced auto-save hook.
 *
 * Writes content to the FileSystemProvider after a delay
 * whenever the content changes. Returns a `flush` function so callers
 * (e.g. an explicit Ctrl/Cmd+S handler) can force an immediate write
 * and await its completion.
 */

import { useEffect, useRef, useCallback } from 'react';
import type { FileSystemProvider } from '@bendyline/docblocks/filesystem';

export interface UseAutoSaveResult {
  /** Cancel any pending debounce and write the current content immediately. */
  flush: () => Promise<void>;
}

export function useAutoSave(
  provider: FileSystemProvider | null,
  filePath: string | null,
  content: string,
  delayMs = 500,
  onSaved?: (filePath: string, content: string) => void,
): UseAutoSaveResult {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef(content);
  const onSavedRef = useRef(onSaved);
  const targetRef = useRef<{
    provider: FileSystemProvider;
    filePath: string;
    lastSaved: string;
  } | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const flushTarget = useCallback(
    async (
      target: {
        provider: FileSystemProvider;
        filePath: string;
        lastSaved: string;
      },
      nextContent: string,
    ) => {
      if (nextContent === target.lastSaved) return;
      const previous = target.lastSaved;
      target.lastSaved = nextContent;
      try {
        await target.provider.writeFile(target.filePath, nextContent);
        onSavedRef.current?.(target.filePath, nextContent);
      } catch (err) {
        target.lastSaved = previous;
        throw err;
      }
    },
    [],
  );

  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  useEffect(() => {
    clearTimer();
    targetRef.current = provider && filePath ? { provider, filePath, lastSaved: content } : null;
    contentRef.current = content;

    return () => {
      clearTimer();
      const target = targetRef.current;
      if (target) {
        void flushTarget(target, contentRef.current).catch(() => undefined);
      }
      targetRef.current = null;
    };
    // `content` is intentionally captured only when the save target changes.
    // Content edits are handled by the debounced effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, filePath, clearTimer, flushTarget]);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    clearTimer();

    if (content !== target.lastSaved) {
      timerRef.current = setTimeout(() => {
        const currentTarget = targetRef.current;
        if (!currentTarget) return;
        void flushTarget(currentTarget, contentRef.current).catch(() => undefined);
      }, delayMs);
    }

    return () => {
      clearTimer();
    };
  }, [content, delayMs, clearTimer, flushTarget]);

  const flush = useCallback(async () => {
    clearTimer();
    const target = targetRef.current;
    if (!target) return;
    await flushTarget(target, contentRef.current);
  }, [clearTimer, flushTarget]);

  return { flush };
}
