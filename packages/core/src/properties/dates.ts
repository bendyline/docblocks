/**
 * Calendar dates for document properties.
 *
 * A due date is a day on the person's own calendar, not an instant: a task
 * due on the 25th is due on the 25th wherever the file is opened. So dates
 * are kept as `YYYY-MM-DD` text and never passed through `Date` parsing,
 * which would read a bare date as UTC midnight and shift it a day for half
 * the world. Arithmetic runs on UTC day numbers, which have no daylight
 * saving gaps.
 */

/** `YYYY-MM-DD`, a real calendar day. */
export type LocalDate = string;

/** `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`: a day, or a time on that day, in local time. */
export type DueValue = string;

export const REPEAT_RULES = ['daily', 'weekly', 'monthly', 'yearly'] as const;
export type RepeatRule = (typeof REPEAT_RULES)[number];

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Seconds and a space separator are accepted on the way in and dropped. */
const DUE_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/;

const MS_PER_DAY = 86_400_000;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function dayNumber(date: LocalDate): number | null {
  const match = DATE_PATTERN.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const instant = new Date(Date.UTC(year, month - 1, day));
  // Years below 100 would be read as 19xx; set the year explicitly.
  instant.setUTCFullYear(year);
  // `Date.UTC` rolls 31 February into March; a real day survives unchanged.
  if (instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day) return null;
  return Math.round(instant.getTime() / MS_PER_DAY);
}

function fromDayNumber(days: number): LocalDate {
  const instant = new Date(days * MS_PER_DAY);
  return `${pad(instant.getUTCFullYear(), 4)}-${pad(instant.getUTCMonth() + 1)}-${pad(instant.getUTCDate())}`;
}

/** True for `YYYY-MM-DD` naming a day that exists. */
export function isLocalDate(value: unknown): value is LocalDate {
  return typeof value === 'string' && dayNumber(value) !== null;
}

/** The calendar day `instant` falls on where the person is. */
export function localDateOf(instant: Date): LocalDate {
  return `${pad(instant.getFullYear(), 4)}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`;
}

/** `HH:mm` on the person's clock. */
export function localTimeOf(instant: Date): string {
  return `${pad(instant.getHours())}:${pad(instant.getMinutes())}`;
}

/**
 * The canonical form of a due value, or null when the text is not one.
 * `2026-11-25 15:00:00` becomes `2026-11-25T15:00`.
 */
export function normalizeDue(value: unknown): DueValue | null {
  if (typeof value !== 'string') return null;
  const match = DUE_PATTERN.exec(value.trim());
  if (!match) return null;
  const date = match[1]!;
  if (dayNumber(date) === null) return null;
  if (match[2] === undefined) return date;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) return null;
  return `${date}T${match[2]}:${match[3]}`;
}

/** The day a due value falls on. `due` must already be normalized. */
export function dueDate(due: DueValue): LocalDate {
  return due.slice(0, 10);
}

/** The time of a due value, or null for an all-day one. */
export function dueTime(due: DueValue): string | null {
  return due.length > 10 ? due.slice(11, 16) : null;
}

/** Day of the week, 0 for Sunday. */
export function weekdayOf(date: LocalDate): number {
  const days = dayNumber(date);
  if (days === null) throw new RangeError('Not a calendar date.');
  return new Date(days * MS_PER_DAY).getUTCDay();
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  const start = dayNumber(from);
  const end = dayNumber(to);
  if (start === null || end === null) throw new RangeError('Not a calendar date.');
  return end - start;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const start = dayNumber(date);
  if (start === null) throw new RangeError('Not a calendar date.');
  return fromDayNumber(start + days);
}

/** The same day `months` later, or that month's last day when it is shorter. */
export function addMonths(date: LocalDate, months: number): LocalDate {
  const match = DATE_PATTERN.exec(date);
  if (!match || dayNumber(date) === null) throw new RangeError('Not a calendar date.');
  const year = Number(match[1]);
  const month = Number(match[2]) - 1 + months;
  const day = Number(match[3]);
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${pad(targetYear, 4)}-${pad(targetMonth + 1)}-${pad(Math.min(day, lastDay))}`;
}

/** Orders due values by day, an all-day one before a timed one on the same day. */
export function compareDue(left: DueValue, right: DueValue): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type DueStatus = 'overdue' | 'today' | 'tomorrow' | 'upcoming';

/** Where a due value stands against `today`, and how many days away it is. */
export function describeDue(
  due: DueValue,
  today: LocalDate,
): { readonly status: DueStatus; readonly days: number } {
  const days = daysBetween(today, dueDate(due));
  const status: DueStatus =
    days < 0 ? 'overdue' : days === 0 ? 'today' : days === 1 ? 'tomorrow' : 'upcoming';
  return { status, days };
}

function step(date: LocalDate, rule: RepeatRule, count: number): LocalDate {
  switch (rule) {
    case 'daily':
      return addDays(date, count);
    case 'weekly':
      return addDays(date, 7 * count);
    case 'monthly':
      return addMonths(date, count);
    case 'yearly':
      return addMonths(date, 12 * count);
  }
}

/**
 * When a repeating item is next due once the one due at `due` is done.
 *
 * It is the first occurrence after both `due` and `today`, so finishing a
 * weekly task three weeks late schedules next week's, not three stale ones.
 * Steps are counted from the original date, so a monthly task due on the 31st
 * returns to the 31st after a short month.
 */
export function nextOccurrence(due: DueValue, rule: RepeatRule, today: LocalDate): DueValue {
  const start = dueDate(due);
  const time = dueTime(due);
  let count = 1;
  let next = step(start, rule, count);
  // Bounded: a daily rule a century stale is the worst case worth serving.
  while (next <= today && count < 40_000) {
    count += 1;
    next = step(start, rule, count);
  }
  return time ? `${next}T${time}` : next;
}
