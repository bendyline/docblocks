import { useCallback, useEffect, useRef, useState } from 'react';
import { titleForSelectedFile } from './document-title.js';

/** How long an open may take before the notice appears, and before it explains. */
export interface OpeningNoticeDelays {
  readonly noticeMs: number;
  readonly slowMs: number;
}

const DEFAULT_DELAYS: OpeningNoticeDelays = { noticeMs: 1_000, slowMs: 8_000 };

export interface OpeningNoticeState {
  readonly name: string;
  readonly slow: boolean;
}

/**
 * Tracks the document being opened so a slow open is visible. An open waits
 * on storage, and a file a sync client keeps online (OneDrive, iCloud) has to
 * download first; without a notice the click looks like it did nothing.
 *
 * `track(path)` starts tracking and returns the function that ends it. Only
 * the latest open is shown, and a notice already on screen switches to it.
 */
export function useOpeningNotice(delays: OpeningNoticeDelays = DEFAULT_DELAYS): {
  notice: OpeningNoticeState | null;
  track: (path: string) => () => void;
} {
  const [notice, setNotice] = useState<OpeningNoticeState | null>(null);
  const currentRef = useRef<object | null>(null);
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const { noticeMs, slowMs } = delays;

  const track = useCallback(
    (path: string) => {
      const token = {};
      currentRef.current = token;
      const name = titleForSelectedFile(path, undefined, undefined, false) || path;
      setNotice((shown) => (shown ? { name, slow: false } : shown));
      const timers = timersRef.current;
      const show = (slow: boolean) => {
        if (currentRef.current === token) setNotice({ name, slow });
      };
      const started = [
        setTimeout(() => show(false), noticeMs),
        setTimeout(() => show(true), slowMs),
      ];
      for (const timer of started) timers.add(timer);
      return () => {
        for (const timer of started) {
          clearTimeout(timer);
          timers.delete(timer);
        }
        if (currentRef.current !== token) return;
        currentRef.current = null;
        setNotice(null);
      };
    },
    [noticeMs, slowMs],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return { notice, track };
}
