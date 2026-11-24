/**
 * Desktop reminders: the renderer hands over the set of upcoming reminders
 * whenever it changes; this keeps the set on disk, arms a timer for the next
 * one, and shows a system notification when one comes due. Timers stop while
 * the computer sleeps, so none runs longer than a minute before the wall
 * clock is read again, and waking re-reads it at once. A relaunch re-arms the set,
 * and anything that came due while the app was closed is shown once (as one
 * summary when there are several), so a reminder is never lost and never
 * repeated.
 *
 * Electron is kept out of this module: `show` and the timers are injected, so
 * the scheduling rules are tested in Node.
 */

import {
  NOTIFICATION_LIMITS,
  parseHostReminders,
  type HostReminder,
} from '@bendyline/docblocks/host';

export interface ReminderNotice {
  readonly title: string;
  readonly body: string;
  /** The reminder to open when the notice is chosen; null for a summary. */
  readonly reminder: HostReminder | null;
}

export interface ReminderStore {
  read(): Promise<unknown>;
  write(state: StoredReminders): Promise<void>;
}

export interface StoredReminders {
  readonly version: 1;
  readonly reminders: readonly HostReminder[];
  /** Ids of reminders already shown, among those still in the set. */
  readonly fired: readonly string[];
}

export interface ReminderSchedulerOptions {
  readonly store: ReminderStore;
  readonly show: (notice: ReminderNotice) => void;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/**
 * The longest one timer runs before the wall clock is read again. Timers
 * count time awake, not time passed: on a computer that slept, or whose
 * clock changed, a reminder is set right within this long (and at once on
 * `wake()`).
 */
const TICK_MS = 60_000;

function parseStored(value: unknown): StoredReminders | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.fired)) return null;
  try {
    const reminders = parseHostReminders(record.reminders);
    const ids = new Set(reminders.map((reminder) => reminder.id));
    const fired = record.fired.filter((id): id is string => typeof id === 'string' && ids.has(id));
    return { version: 1, reminders, fired };
  } catch {
    return null;
  }
}

export class ReminderScheduler {
  private reminders: readonly HostReminder[] = [];
  private readonly fired = new Set<string>();
  private timer: unknown = null;
  private disposed = false;
  /** Writes run one after another, each with the state as it was asked for. */
  private writes: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  public constructor(private readonly options: ReminderSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Load the kept set, show what came due while closed, and arm the rest. */
  public async start(): Promise<void> {
    let stored: StoredReminders | null = null;
    try {
      stored = parseStored(await this.options.store.read());
    } catch {
      stored = null;
    }
    if (stored) {
      this.reminders = stored.reminders;
      for (const id of stored.fired) this.fired.add(id);
    }
    const now = this.now();
    const missed = this.reminders.filter(
      (reminder) => Date.parse(reminder.at) <= now && !this.fired.has(reminder.id),
    );
    if (missed.length === 1) {
      this.fire(missed[0]!);
    } else if (missed.length > 1) {
      for (const reminder of missed) this.fired.add(reminder.id);
      this.options.show({
        title: `${missed.length} tasks came due`,
        body: missed
          .slice(0, 3)
          .map((reminder) => reminder.title)
          .join(', ')
          .concat(missed.length > 3 ? ', …' : ''),
        reminder: null,
      });
    }
    this.arm();
    await this.persist();
  }

  /**
   * Replace the set. Reminders already shown stay shown; new ones are armed.
   * One whose time came while the computer slept is shown first rather than
   * dropped with the old set (the renderer leaves out past reminders).
   */
  public async sync(value: unknown): Promise<void> {
    const reminders = parseHostReminders(value);
    this.catchUp();
    const horizon = this.now() + NOTIFICATION_LIMITS.maxDaysAhead * 86_400_000;
    this.reminders = reminders.filter((reminder) => Date.parse(reminder.at) <= horizon);
    const ids = new Set(this.reminders.map((reminder) => reminder.id));
    for (const id of [...this.fired]) if (!ids.has(id)) this.fired.delete(id);
    this.arm();
    await this.persist();
  }

  /** Reminders still to come, soonest first. */
  public pending(): readonly HostReminder[] {
    return this.reminders
      .filter((reminder) => !this.fired.has(reminder.id))
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  }

  /** The computer woke or was unlocked: show what came due meanwhile. */
  public wake(): void {
    if (this.disposed) return;
    const before = this.fired.size;
    this.arm();
    if (this.fired.size !== before) void this.persist();
  }

  public dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** Show every reminder in the set whose time has come. */
  private catchUp(): void {
    const now = this.now();
    for (const reminder of this.reminders) {
      if (Date.parse(reminder.at) <= now) this.fire(reminder);
    }
  }

  /** Show what is due, then set one timer for the next reminder (or the next tick). */
  private arm(): void {
    if (this.disposed) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.catchUp();
    const now = this.now();
    let next = Number.POSITIVE_INFINITY;
    for (const reminder of this.reminders) {
      if (!this.fired.has(reminder.id)) next = Math.min(next, Date.parse(reminder.at));
    }
    if (next === Number.POSITIVE_INFINITY) return;
    this.timer = this.setTimer(
      () => {
        this.timer = null;
        this.wake();
      },
      Math.max(0, Math.min(next - now, TICK_MS)),
    );
  }

  private fire(reminder: HostReminder): void {
    if (this.disposed || this.fired.has(reminder.id)) return;
    this.fired.add(reminder.id);
    this.options.show({ title: reminder.title, body: reminder.body, reminder });
  }

  private persist(): Promise<void> {
    const state: StoredReminders = {
      version: 1,
      reminders: this.reminders,
      fired: [...this.fired],
    };
    // One at a time: two writes of the same file at once could interleave.
    this.writes = this.writes
      .then(() => this.options.store.write(state))
      .catch(() => {
        // A reminder that could not be kept on disk still fires this session.
      });
    return this.writes;
  }
}
