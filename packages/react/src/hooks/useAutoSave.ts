/**
 * useAutoSave — debounced auto-save hook.
 *
 * Writes content to the FileSystemProvider after a delay
 * whenever the content changes.
 */

import { useEffect, useRef, useCallback } from 'react';
import type { FileSystemProvider } from '@bendyline/docblocks/filesystem';

export function useAutoSave(
  provider: FileSystemProvider | null,
  filePath: string | null,
  content: string,
  delayMs = 500,
): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>(content);

  const save = useCallback(async () => {
    if (!provider || !filePath) return;
    if (content === lastSavedRef.current) return;
    lastSavedRef.current = content;
    await provider.writeFile(filePath, content);
  }, [provider, filePath, content]);

  useEffect(() => {
    if (!provider || !filePath) return;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      save();
    }, delayMs);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [content, delayMs, save, provider, filePath]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      // Sync save on unmount is best-effort
      if (provider && filePath && content !== lastSavedRef.current) {
        provider.writeFile(filePath, content);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
