/**
 * `host.notifications` in the renderer: reminders and the app icon's count,
 * over IPC. Values cross the boundary parsed on both sides.
 */

import {
  parseBadgeCount,
  parseHostReminders,
  parseNotificationPermission,
  type DocBlocksHostNotificationsAPI,
} from '@bendyline/docblocks/host';

export interface NotificationsIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

export function createNotificationsApi(ipc: NotificationsIpc): DocBlocksHostNotificationsAPI {
  return {
    status: async () => parseNotificationPermission(await ipc.invoke('notifications:status')),
    requestPermission: async () =>
      parseNotificationPermission(await ipc.invoke('notifications:requestPermission')),
    syncReminders: async (reminders) => {
      await ipc.invoke('notifications:syncReminders', parseHostReminders(reminders));
    },
    setBadge: async (count) => {
      await ipc.invoke('notifications:setBadge', parseBadgeCount(count));
    },
  };
}
