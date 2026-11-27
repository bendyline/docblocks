/**
 * Read a due date out of a line someone typed to capture a task:
 * "Call Priya tomorrow" is a task named "Call Priya", due tomorrow.
 *
 * English phrases only. The rules lean towards leaving the text alone: a
 * phrase is taken as a date only where it reads as one, because a task that
 * silently loses a word of its name is worse than one with no date.
 */

import {
  addDays,
  addMonths,
  isLocalDate,
  weekdayOf,
  type DueValue,
  type LocalDate,
} from './dates.js';

export interface Capture {
  /** The text with the date phrase taken out. */
  readonly title: string;
  readonly due?: DueValue;
}

interface Found {
  readonly index: number;
  readonly length: number;
  readonly date: LocalDate;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_ABBREVIATIONS = 'sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat';
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const MONTH_NAMES = `${MONTHS.join('|')}|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec`;
const LEAD = '(?:(?:on|by|due|before)\\s+)?';

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function nextWeekday(name: string, today: LocalDate): LocalDate {
  const wanted = WEEKDAYS.findIndex((day) => day.startsWith(name.slice(0, 3).toLowerCase()));
  const ahead = (wanted - weekdayOf(today) + 7) % 7 || 7;
  return addDays(today, ahead);
}

/** The next time that month and day come round, today included. */
function nextMonthDay(month: string, day: number, today: LocalDate): LocalDate | null {
  const monthIndex = MONTHS.findIndex((name) => name.startsWith(month.slice(0, 3).toLowerCase()));
  const year = Number(today.slice(0, 4));
  for (const candidateYear of [year, year + 1]) {
    const candidate = `${pad(candidateYear, 4)}-${pad(monthIndex + 1)}-${pad(day)}`;
    if (isLocalDate(candidate) && candidate >= today) return candidate;
  }
  return null;
}

function unitDays(count: number, unit: string, today: LocalDate): LocalDate {
  if (unit.startsWith('month')) return addMonths(today, count);
  return addDays(today, unit.startsWith('week') ? count * 7 : count);
}

type Rule = readonly [RegExp, (match: RegExpExecArray, today: LocalDate) => LocalDate | null];

const RULES: readonly Rule[] = [
  [new RegExp(`\\b${LEAD}(?:today|tonight)\\b`, 'gi'), (_match, today) => today],
  [new RegExp(`\\b${LEAD}(?:tomorrow|tmrw)\\b`, 'gi'), (_match, today) => addDays(today, 1)],
  [new RegExp(`\\b${LEAD}next week\\b`, 'gi'), (_match, today) => addDays(today, 7)],
  [new RegExp(`\\b${LEAD}next month\\b`, 'gi'), (_match, today) => addMonths(today, 1)],
  [
    /\bin (\d{1,3}) (days?|weeks?|months?)\b/gi,
    (match, today) => unitDays(Number(match[1]), match[2]!.toLowerCase(), today),
  ],
  [
    new RegExp(`\\b${LEAD}(?:(?:next|this)\\s+)?(${WEEKDAYS.join('|')})\\b`, 'gi'),
    (match, today) => nextWeekday(match[1]!, today),
  ],
  // A short weekday is a common word ("sat", "sun", "wed"), so it counts only
  // after a word that announces a date, or as the last word typed.
  [
    new RegExp(`\\b(?:on|by|due|before|next|this)\\s+(${WEEKDAY_ABBREVIATIONS})\\b`, 'gi'),
    (match, today) => nextWeekday(match[1]!, today),
  ],
  [
    new RegExp(`\\b(${WEEKDAY_ABBREVIATIONS})\\s*$`, 'gi'),
    (match, today) => nextWeekday(match[1]!, today),
  ],
  [
    new RegExp(`\\b${LEAD}(\\d{4}-\\d{2}-\\d{2})\\b`, 'gi'),
    (match) => (isLocalDate(match[1]) ? match[1]! : null),
  ],
  [
    new RegExp(`\\b${LEAD}(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'),
    (match, today) => nextMonthDay(match[1]!, Number(match[2]), today),
  ],
  [
    new RegExp(`\\b${LEAD}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_NAMES})\\b`, 'gi'),
    (match, today) => nextMonthDay(match[2]!, Number(match[1]), today),
  ],
];

/** `at 3pm`, `3:30 pm`, `at 15:00`. A bare `at 3` is too often an address. */
const TIME =
  /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bat\s+(\d{1,2}):(\d{2})\b|\b(?:at\s+)?(noon|midnight)\b/i;

function findDate(text: string, today: LocalDate): Found | null {
  let best: Found | null = null;
  for (const [pattern, resolve] of RULES) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const date = resolve(match, today);
      if (!date) continue;
      const found = { index: match.index, length: match[0].length, date };
      // The last date phrase wins; for the same place, the longer reading.
      if (
        !best ||
        found.index > best.index + best.length - 1 ||
        (found.index === best.index && found.length > best.length)
      ) {
        best = found;
      }
    }
  }
  return best;
}

function findTime(text: string): { index: number; length: number; time: string } | null {
  const match = TIME.exec(text);
  if (!match) return null;
  let hours: number;
  let minutes: number;
  if (match[6]) {
    hours = match[6].toLowerCase() === 'noon' ? 12 : 0;
    minutes = 0;
  } else if (match[3]) {
    hours = Number(match[1]);
    minutes = match[2] ? Number(match[2]) : 0;
    if (hours < 1 || hours > 12) return null;
    const afternoon = match[3].toLowerCase() === 'pm';
    hours = (hours % 12) + (afternoon ? 12 : 0);
  } else {
    hours = Number(match[4]);
    minutes = Number(match[5]);
  }
  if (hours > 23 || minutes > 59) return null;
  return { index: match.index, length: match[0].length, time: `${pad(hours)}:${pad(minutes)}` };
}

function cut(text: string, index: number, length: number): string {
  return `${text.slice(0, index)} ${text.slice(index + length)}`;
}

function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+(?:on|by|due|before|at)\s*$/i, '')
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '')
    .trim();
}

/**
 * Split typed text into a title and, when it names one, a due date.
 * `today` is the person's calendar day (see `localDateOf`).
 */
export function parseCapture(text: string, today: LocalDate): Capture {
  const original = text.replace(/\s+/g, ' ').trim();
  let rest = original;
  let date: LocalDate | null = null;

  const found = findDate(rest, today);
  if (found) {
    date = found.date;
    rest = cut(rest, found.index, found.length);
  }
  const time = findTime(rest);
  if (time) rest = cut(rest, time.index, time.length);
  if (!date && !time) return { title: original };

  const due = time ? `${date ?? today}T${time.time}` : date!;
  // Text that was nothing but a date keeps its words as the name.
  return { title: tidy(rest) || original, due };
}
