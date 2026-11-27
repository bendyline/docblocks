/**
 * Whether DocBlocks reminds the person when tasks come due, and when in the
 * day an all-day task's reminder goes off. Stored per device, like the other
 * app preferences: reminders are this device's notifications.
 */

export interface ReminderPreferences {
  readonly enabled: boolean;
  /** `HH:mm` on the person's clock, for tasks due on a day rather than at a time. */
  readonly allDayTime: string;
}

const STORAGE_KEY = 'docblocks:reminders';
export const DEFAULT_REMINDER_PREFERENCES: ReminderPreferences = Object.freeze({
  enabled: false,
  allDayTime: '09:00',
});

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function loadReminderPreferences(): ReminderPreferences {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as unknown;
    if (typeof raw !== 'object' || raw === null) return DEFAULT_REMINDER_PREFERENCES;
    const record = raw as Record<string, unknown>;
    return {
      enabled: record.enabled === true,
      allDayTime:
        typeof record.allDayTime === 'string' && TIME.test(record.allDayTime)
          ? record.allDayTime
          : DEFAULT_REMINDER_PREFERENCES.allDayTime,
    };
  } catch {
    return DEFAULT_REMINDER_PREFERENCES;
  }
}

export function saveReminderPreferences(preferences: ReminderPreferences): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        enabled: preferences.enabled,
        allDayTime: TIME.test(preferences.allDayTime)
          ? preferences.allDayTime
          : DEFAULT_REMINDER_PREFERENCES.allDayTime,
      }),
    );
  } catch {
    // ignore unavailable storage
  }
}
