import { useEffect, useRef } from 'react';
import type { DocBlocksHostNotificationsAPI } from '@bendyline/docblocks/host';
import type { LocalDate } from '@bendyline/docblocks/properties';
import type { TaskItem } from '../Tasks/task-model.js';
import { reminderBadgeCount, remindersFor } from '../Tasks/reminders.js';

const SYNC_DEBOUNCE_MS = 2_000;

interface BadgeNavigator {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

/**
 * Keep the host's scheduled reminders and the app icon's count in step with
 * the tasks. Off: every reminder is cancelled and the count cleared. While the
 * tasks are not known (`ready` false) nothing is sent, so the host keeps the
 * set it has. Where no host can notify (the browser build), only the count is
 * shown, through the browser's app badge when it has one.
 */
export function useReminderSync(input: {
  readonly notifications: DocBlocksHostNotificationsAPI | null;
  /** The person's switch. Only this being off cancels reminders. */
  readonly enabled: boolean;
  readonly allDayTime: string;
  readonly items: readonly TaskItem[];
  readonly workspaceNames: ReadonlyMap<string, string>;
  readonly today: LocalDate;
  /**
   * False until the tasks are known: a half-read workspace, or no workspace
   * the Home pages can read (a loose file opened from the OS), never cancels
   * reminders.
   */
  readonly ready: boolean;
  /** How long changes settle before they are sent; tests shorten it. */
  readonly debounceMs?: number;
}): void {
  const { notifications, enabled, allDayTime, items, workspaceNames, today, ready } = input;
  const debounceMs = input.debounceMs ?? SYNC_DEBOUNCE_MS;
  const lastSent = useRef<string | null>(null);
  const lastBadge = useRef<number | null>(null);

  useEffect(() => {
    if (!ready && enabled) return;
    const timer = setTimeout(() => {
      const reminders = enabled
        ? remindersFor(items, { now: new Date(), today, allDayTime, workspaceNames })
        : [];
      const badge = enabled ? reminderBadgeCount(items, today) : 0;
      const signature = JSON.stringify(reminders);
      if (notifications) {
        if (signature !== lastSent.current) {
          lastSent.current = signature;
          void notifications.syncReminders(reminders).catch(() => {
            lastSent.current = null;
          });
        }
        if (badge !== lastBadge.current && notifications.setBadge) {
          lastBadge.current = badge;
          void notifications.setBadge(badge).catch(() => {
            lastBadge.current = null;
          });
        }
        return;
      }
      if (badge === lastBadge.current) return;
      lastBadge.current = badge;
      const nav = (typeof navigator === 'undefined' ? {} : navigator) as BadgeNavigator;
      try {
        if (badge > 0) void nav.setAppBadge?.(badge)?.catch(() => undefined);
        else void nav.clearAppBadge?.()?.catch(() => undefined);
      } catch {
        // No app badge in this browser.
      }
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [notifications, enabled, allDayTime, items, workspaceNames, today, ready, debounceMs]);
}
