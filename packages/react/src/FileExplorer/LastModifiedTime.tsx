import { useSyncExternalStore } from 'react';
import { formatFriendlyLastModified } from './last-modified.js';

const CLOCK_INTERVAL_MS = 60_000;

type ClockListener = () => void;

let clockNow = Date.now();
let clockTimer: ReturnType<typeof setInterval> | null = null;
const clockListeners = new Set<ClockListener>();

function publishClockTick(): void {
  clockNow = Date.now();
  for (const listener of clockListeners) listener();
}

function subscribeToClock(listener: ClockListener): () => void {
  clockListeners.add(listener);
  if (clockListeners.size === 1) {
    // Refresh a clock that may have been idle before React verifies the
    // snapshot after subscribing, then keep one timer for every visible row.
    clockNow = Date.now();
    clockTimer = globalThis.setInterval(publishClockTick, CLOCK_INTERVAL_MS);
  }

  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== null) {
      globalThis.clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

function getClockSnapshot(): number {
  return clockNow;
}

export interface LastModifiedTimeProps {
  readonly value: string;
}

/**
 * A self-updating timestamp leaf. Its shared external clock re-renders only
 * this small component, never the FileExplorer or FileTreeNode that owns it.
 */
export function LastModifiedTime({ value }: LastModifiedTimeProps) {
  const now = useSyncExternalStore(subscribeToClock, getClockSnapshot, getClockSnapshot);
  const lastModified = formatFriendlyLastModified(value, now);
  if (!lastModified) return null;

  return (
    <time
      className="db-tree-last-modified"
      dateTime={value}
      title={lastModified.title}
      aria-label={lastModified.accessibleLabel}
    >
      {lastModified.shortLabel}
    </time>
  );
}
