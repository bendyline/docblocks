/**
 * Facts from the person's task list, for a question asked of their notes.
 *
 * Questions about what is due are answered from these, exactly as the files
 * say, rather than from what a model infers from passages: a model asked
 * "what is due this week?" should read a list, not guess at one.
 */

import {
  daysBetween,
  describeDue,
  dueDate,
  isLocalDate,
  weekdayOf,
  type LocalDate,
} from '@bendyline/docblocks/properties';
import type { TaskItem } from '../Tasks/task-model.js';

const AHEAD_DAYS = 14;
const DONE_DAYS = 7;
const MAX_LINES_PER_SECTION = 25;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `Monday 23 November 2026`, the same on every device: it is read by a model, not a person. */
function longDate(date: LocalDate): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return `${WEEKDAYS[weekdayOf(date)]} ${day} ${MONTHS[month - 1]} ${year}`;
}

function line(item: TaskItem, workspaceNames: ReadonlyMap<string, string>, when: string): string {
  const where = [workspaceNames.get(item.workspaceId), item.folder, item.bucket]
    .filter(Boolean)
    .join(' › ');
  const details = [
    when,
    item.category && `category ${item.category}`,
    item.repeat && `repeats ${item.repeat}`,
  ]
    .filter(Boolean)
    .join('; ');
  return `- ${item.title} (${details}${where ? `; in ${where}` : ''})`;
}

function section(title: string, lines: string[]): string[] {
  if (lines.length === 0) return [];
  const shown = lines.slice(0, MAX_LINES_PER_SECTION);
  const more = lines.length - shown.length;
  return [title, ...shown, ...(more > 0 ? [`- and ${more} more`] : [])];
}

/** The task facts to send with a question, or null when there is nothing to tell. */
export function taskFacts(
  items: readonly TaskItem[],
  today: LocalDate,
  workspaceNames: ReadonlyMap<string, string>,
): string | null {
  const overdue: string[] = [];
  const upcoming: Array<{ due: string; text: string }> = [];
  const finished: string[] = [];
  for (const item of items) {
    if (item.pending) continue;
    if (item.done) {
      const on = item.completedOn;
      if (on && isLocalDate(on) && daysBetween(on, today) <= DONE_DAYS) {
        finished.push(line(item, workspaceNames, `finished ${on}`));
      }
      continue;
    }
    if (!item.due) continue;
    const { status, days } = describeDue(item.due, today);
    if (status === 'overdue') {
      overdue.push(line(item, workspaceNames, `was due ${dueDate(item.due)}, ${-days} days ago`));
    } else if (days <= AHEAD_DAYS) {
      const when =
        status === 'today'
          ? 'due today'
          : status === 'tomorrow'
            ? 'due tomorrow'
            : `due ${item.due}`;
      upcoming.push({ due: item.due, text: line(item, workspaceNames, when) });
    }
  }
  upcoming.sort((left, right) => (left.due < right.due ? -1 : left.due > right.due ? 1 : 0));
  const body = [
    ...section('Overdue:', overdue),
    ...section(
      `Due in the next ${AHEAD_DAYS} days:`,
      upcoming.map((entry) => entry.text),
    ),
    ...section(`Finished in the last ${DONE_DAYS} days:`, finished),
  ];
  if (body.length === 0) return null;
  return [`Today is ${longDate(today)} (${today}).`, ...body].join('\n');
}
