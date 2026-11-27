/**
 * `host.notifications` on desktop: reminders with Electron's system
 * notifications, and the count on the dock (macOS) or launcher (Linux).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { app, Notification, type BrowserWindow } from 'electron';
import { parseBadgeCount, type NotificationPermission } from '@bendyline/docblocks/host';
import { registerTrustedIpcHandler } from './ipc-authority.js';
import { sendOpenRequest } from './open-requests.js';
import { ReminderScheduler, type ReminderNotice, type StoredReminders } from './reminders.js';
import { showAndFocusWindow } from './window-activation.js';

export interface ReminderWindowHost {
  getWindow(): BrowserWindow | null;
  ensureWindow(): void;
}

const MAX_DEFERRED = 4;

export interface NotificationService {
  readonly scheduler: ReminderScheduler;
  /** True while a reminder is still to come: worth staying alive in the tray for. */
  hasPending(): boolean;
  /** A window now exists: open what a reminder clicked while there was none asked for. */
  windowReady(win: BrowserWindow): void;
  dispose(): void;
}

function permission(): NotificationPermission {
  return Notification.isSupported() ? 'available' : 'unavailable';
}

export async function createNotificationService(
  host: ReminderWindowHost,
): Promise<NotificationService> {
  const file = path.join(app.getPath('userData'), 'reminders.json');
  const deferred: ((win: BrowserWindow) => void)[] = [];
  // Notifications are kept referenced until closed, or Electron may collect
  // them and drop their click handlers.
  const live = new Set<Notification>();

  const openFromNotice = (notice: ReminderNotice) => {
    const deliver = (win: BrowserWindow) => {
      showAndFocusWindow(app, win);
      if (notice.reminder) {
        sendOpenRequest(win, {
          kind: 'workspace-file',
          workspaceId: notice.reminder.workspaceId,
          path: notice.reminder.path,
        });
      }
    };
    const win = host.getWindow();
    if (win) {
      deliver(win);
      return;
    }
    if (deferred.length < MAX_DEFERRED) deferred.push(deliver);
    host.ensureWindow();
  };

  const scheduler = new ReminderScheduler({
    store: {
      read: async () => {
        try {
          return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
        } catch {
          return null;
        }
      },
      write: async (state: StoredReminders) => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(state), 'utf8');
        await fs.rename(temporary, file);
      },
    },
    show: (notice) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title: notice.title, body: notice.body });
      live.add(notification);
      notification.on('click', () => openFromNotice(notice));
      notification.on('close', () => live.delete(notification));
      notification.show();
    },
  });
  await scheduler.start();

  registerTrustedIpcHandler('notifications:status', 0, () => permission());
  registerTrustedIpcHandler('notifications:requestPermission', 0, () => permission());
  registerTrustedIpcHandler('notifications:syncReminders', 1, async (_event, value: unknown) => {
    await scheduler.sync(value);
  });
  registerTrustedIpcHandler('notifications:setBadge', 1, (_event, value: unknown) => {
    // macOS (dock) and Linux (Unity launchers) show it; elsewhere this is a no-op.
    app.setBadgeCount(parseBadgeCount(value));
  });

  return {
    scheduler,
    hasPending: () => scheduler.pending().length > 0,
    windowReady: (win) => {
      for (const action of deferred.splice(0)) action(win);
    },
    dispose: () => scheduler.dispose(),
  };
}
