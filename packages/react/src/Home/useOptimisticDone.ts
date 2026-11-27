import { useEffect, useRef, useState } from 'react';

/** How long a tick waits for the files to agree before it is given up. */
const SETTLE_MS = 5_000;

/**
 * A task's checkbox state as the person sees it. Ticking shows at once; the
 * file operation and the index catching up follow a moment later. The shown
 * state falls back to the files' when they change, or when they never do
 * (the action failed and said so).
 */
export function useOptimisticDone(done: boolean): {
  readonly shown: boolean;
  readonly pending: boolean;
  readonly begin: () => boolean;
  readonly end: () => void;
} {
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  // The files moved: they now say what is true.
  useEffect(() => {
    clearTimer();
    setOptimistic(null);
  }, [done]);
  useEffect(() => clearTimer, []);
  return {
    shown: optimistic ?? done,
    pending: optimistic !== null,
    begin: () => {
      const next = !done;
      setOptimistic(next);
      return next;
    },
    end: () => {
      clearTimer();
      timer.current = setTimeout(() => setOptimistic(null), SETTLE_MS);
    },
  };
}
