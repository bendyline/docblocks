const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const shortDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

function plural(value: number, unit: string): string {
  return `${value.toLocaleString()} ${unit}${value === 1 ? '' : 's'}`;
}

/** Plain-language age of a timestamp, or null when clock skew makes it meaningless. */
export function describeAge(timestamp: number, now: number): string | null {
  const elapsed = now - timestamp;
  if (elapsed < -MINUTE_MS) return null;
  if (elapsed < 10 * SECOND_MS) return 'just now';
  // Ten-second steps read as an age rather than a running counter.
  if (elapsed < MINUTE_MS) return `${Math.floor(elapsed / (10 * SECOND_MS)) * 10} seconds ago`;
  if (elapsed < HOUR_MS) return `${plural(Math.floor(elapsed / MINUTE_MS), 'minute')} ago`;
  if (elapsed < DAY_MS) return `${plural(Math.floor(elapsed / HOUR_MS), 'hour')} ago`;
  if (elapsed < 2 * DAY_MS) return 'yesterday';
  if (elapsed < 7 * DAY_MS) return `${plural(Math.floor(elapsed / DAY_MS), 'day')} ago`;
  return `on ${shortDateFormatter.format(new Date(timestamp))}`;
}
