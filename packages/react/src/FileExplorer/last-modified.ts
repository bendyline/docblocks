const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

const shortDateWithYearFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const fullDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export interface FriendlyLastModified {
  /** Compact text intended for the narrow right edge of an explorer row. */
  readonly shortLabel: string;
  /** Complete phrase exposed to assistive technology. */
  readonly accessibleLabel: string;
  /** Stable absolute date and time shown on hover. */
  readonly title: string;
}

function plural(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

/** Turn a provider timestamp into compact, friendly explorer-row text. */
export function formatFriendlyLastModified(
  value: string | undefined,
  now = Date.now(),
): FriendlyLastModified | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;

  const date = new Date(timestamp);
  const elapsed = now - timestamp;
  const title = `Last modified ${fullDateTimeFormatter.format(date)}`;

  if (elapsed >= -MINUTE_MS && elapsed < MINUTE_MS) {
    return { shortLabel: 'Now', accessibleLabel: 'Last modified just now', title };
  }

  if (elapsed >= 0 && elapsed < HOUR_MS) {
    const minutes = Math.max(1, Math.floor(elapsed / MINUTE_MS));
    return {
      shortLabel: `${minutes}m ago`,
      accessibleLabel: `Last modified ${plural(minutes, 'minute')}`,
      title,
    };
  }

  if (elapsed >= 0 && elapsed < DAY_MS) {
    const hours = Math.max(1, Math.floor(elapsed / HOUR_MS));
    return {
      shortLabel: `${hours}h ago`,
      accessibleLabel: `Last modified ${plural(hours, 'hour')}`,
      title,
    };
  }

  if (elapsed >= DAY_MS && elapsed < 2 * DAY_MS) {
    return { shortLabel: 'Yesterday', accessibleLabel: 'Last modified yesterday', title };
  }

  if (elapsed >= 2 * DAY_MS && elapsed < 7 * DAY_MS) {
    const days = Math.floor(elapsed / DAY_MS);
    return {
      shortLabel: `${days}d ago`,
      accessibleLabel: `Last modified ${plural(days, 'day')}`,
      title,
    };
  }

  const currentYear = new Date(now).getFullYear();
  const shortLabel =
    date.getFullYear() === currentYear
      ? shortDateFormatter.format(date)
      : shortDateWithYearFormatter.format(date);
  return { shortLabel, accessibleLabel: title, title };
}
