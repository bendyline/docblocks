/**
 * `host.notifications`: remind the person when a task comes due, and show a
 * count of what is due on the app's icon.
 *
 * The renderer owns what to remind about. It hands the host the whole set of
 * upcoming reminders each time it changes (`syncReminders`); the host keeps
 * that set, re-arms it after a relaunch, and fires each one at its time with
 * the operating system's own notifications. Choosing a reminder opens its
 * document through the ordinary open-request channel.
 *
 * Absent on a host that cannot notify (the browser build, VS Code).
 */

/** One reminder: a document in a workspace, and when to bring it up. */
export interface HostReminder {
  /** Stable for the same document and due time, so a re-sync leaves it armed. */
  readonly id: string;
  /** When to remind, as an ISO 8601 instant (the renderer resolves local time). */
  readonly at: string;
  readonly title: string;
  readonly body: string;
  readonly workspaceId: string;
  /** Root-relative workspace path of the document to open. */
  readonly path: string;
}

/**
 * - `available`: reminders will show.
 * - `prompt`: the operating system will ask the first time (phones).
 * - `denied`: the person turned notifications off for DocBlocks.
 * - `unavailable`: this device cannot show them.
 */
export type NotificationPermission = 'available' | 'prompt' | 'denied' | 'unavailable';

export interface DocBlocksHostNotificationsAPI {
  status(): Promise<NotificationPermission>;
  /** Ask the operating system's permission. Only ever call from a gesture. */
  requestPermission(): Promise<NotificationPermission>;
  /** Replace the scheduled reminders with these. An empty list cancels them all. */
  syncReminders(reminders: readonly HostReminder[]): Promise<void>;
  /** The number on the app icon; 0 clears it. Absent where the icon cannot show one. */
  setBadge?(count: number): Promise<void>;
}

export const NOTIFICATION_LIMITS = Object.freeze({
  /** iOS keeps 64 pending notifications per app; every host uses the same ceiling. */
  maxReminders: 64,
  maxIdCharacters: 128,
  maxTitleCharacters: 200,
  maxBodyCharacters: 400,
  maxWorkspaceIdCharacters: 256,
  maxPathCharacters: 4096,
  maxBadge: 9999,
  /** Furthest ahead a reminder may be scheduled. */
  maxDaysAhead: 60,
});

const PERMISSIONS: ReadonlySet<string> = new Set(['available', 'prompt', 'denied', 'unavailable']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maximum) {
    throw new TypeError(`${label} must be text of at most ${maximum} characters.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} must not hold control characters.`);
  }
  return value;
}

/** A reminder list from the renderer, exact shape and bounds; throws otherwise. */
export function parseHostReminders(value: unknown): HostReminder[] {
  if (!Array.isArray(value)) throw new TypeError('Reminders must be a list.');
  if (value.length > NOTIFICATION_LIMITS.maxReminders) {
    throw new TypeError(`At most ${NOTIFICATION_LIMITS.maxReminders} reminders can be scheduled.`);
  }
  const ids = new Set<string>();
  return value.map((entry): HostReminder => {
    if (!isRecord(entry)) throw new TypeError('A reminder must be an object.');
    const keys = Object.keys(entry).sort().join(',');
    if (keys !== 'at,body,id,path,title,workspaceId') {
      throw new TypeError('A reminder has unexpected or missing fields.');
    }
    const id = boundedText(entry.id, 'A reminder id', NOTIFICATION_LIMITS.maxIdCharacters);
    if (ids.has(id)) throw new TypeError('Reminder ids must be unique.');
    ids.add(id);
    const at = boundedText(entry.at, 'A reminder time', 40);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(at)) {
      throw new TypeError('A reminder time must be an ISO 8601 instant.');
    }
    if (!Number.isFinite(Date.parse(at))) throw new TypeError('A reminder time must be real.');
    const path = boundedText(entry.path, 'A reminder path', NOTIFICATION_LIMITS.maxPathCharacters);
    if (path.startsWith('/') || path.split('/').some((part) => part === '' || part === '..')) {
      throw new TypeError('A reminder path must be a workspace path.');
    }
    return {
      id,
      at,
      title: boundedText(entry.title, 'A reminder title', NOTIFICATION_LIMITS.maxTitleCharacters),
      body: boundedText(entry.body, 'A reminder body', NOTIFICATION_LIMITS.maxBodyCharacters, true),
      workspaceId: boundedText(
        entry.workspaceId,
        'A reminder workspace',
        NOTIFICATION_LIMITS.maxWorkspaceIdCharacters,
      ),
      path,
    };
  });
}

export function parseNotificationPermission(value: unknown): NotificationPermission {
  if (typeof value !== 'string' || !PERMISSIONS.has(value)) {
    throw new TypeError('Not a notification permission.');
  }
  return value as NotificationPermission;
}

export function parseBadgeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError('A badge count must be a whole number, 0 or more.');
  }
  return Math.min(value, NOTIFICATION_LIMITS.maxBadge);
}
