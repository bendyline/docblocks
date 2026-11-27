/**
 * Which reminders to schedule: open tasks with a due date in the coming days,
 * each at its time, or at the person's chosen time for one due on a day. The
 * host keeps and fires them; this only decides what they are.
 */

import { NOTIFICATION_LIMITS, type HostReminder } from '@bendyline/docblocks/host';
import { describeDue, dueDate, dueTime, type LocalDate } from '@bendyline/docblocks/properties';
import type { TaskItem } from './task-model.js';

export const REMINDER_DAYS_AHEAD = 14;

function hash(text: string, seed: number): string {
  let value = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(16).padStart(8, '0');
}

/** The local instant a due value comes round, reminding all-day tasks at `allDayTime`. */
export function reminderInstant(due: string, allDayTime: string): Date {
  const [year, month, day] = dueDate(due).split('-').map(Number) as [number, number, number];
  const [hours, minutes] = (dueTime(due) ?? allDayTime).split(':').map(Number) as [number, number];
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

function dueSentence(due: string, today: LocalDate): string {
  const time = dueTime(due);
  const { status } = describeDue(due, today);
  const day =
    status === 'today' ? 'today' : status === 'tomorrow' ? 'tomorrow' : `on ${dueDate(due)}`;
  return time ? `Due ${day} at ${time}` : `Due ${day}`;
}

export function remindersFor(
  items: readonly TaskItem[],
  options: {
    readonly now: Date;
    readonly today: LocalDate;
    readonly allDayTime: string;
    readonly workspaceNames: ReadonlyMap<string, string>;
  },
): HostReminder[] {
  const now = options.now.getTime();
  const horizon = now + REMINDER_DAYS_AHEAD * 86_400_000;
  const reminders: Array<{ at: number; reminder: HostReminder }> = [];
  for (const item of items) {
    if (item.done || !item.due || item.pending) continue;
    const at = reminderInstant(item.due, options.allDayTime).getTime();
    if (at <= now || at > horizon) continue;
    const key = `${item.workspaceId}\u0000${item.path}\u0000${item.due}`;
    const workspace = options.workspaceNames.get(item.workspaceId);
    reminders.push({
      at,
      reminder: {
        id: `r-${hash(key, 0x811c9dc5)}${hash(key, 0x01234567)}`,
        at: new Date(at).toISOString(),
        title: item.title.slice(0, NOTIFICATION_LIMITS.maxTitleCharacters),
        body: [dueSentence(item.due, options.today), workspace]
          .filter(Boolean)
          .join(' · ')
          .slice(0, NOTIFICATION_LIMITS.maxBodyCharacters),
        workspaceId: item.workspaceId,
        path: item.path,
      },
    });
  }
  return reminders
    .sort((left, right) => left.at - right.at)
    .slice(0, NOTIFICATION_LIMITS.maxReminders)
    .map((entry) => entry.reminder);
}

/** The number on the app icon: open tasks overdue or due today. */
export function reminderBadgeCount(items: readonly TaskItem[], today: LocalDate): number {
  let count = 0;
  for (const item of items) {
    if (item.done || !item.due) continue;
    const { status } = describeDue(item.due, today);
    if (status === 'overdue' || status === 'today') count += 1;
  }
  return count;
}
