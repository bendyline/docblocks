/**
 * `host.notifications` on the phones: reminders scheduled with the operating
 * system, through Capacitor's local notifications plugin, so they go off with
 * the app closed. Tapping one opens its document.
 *
 * The plugin is reached by name, so its web half never enters the bundle. A
 * build without its native half (a web preview) gets null from
 * `installMobileNotifications` and the host has no reminders, which the shell
 * reads as "this device cannot remind".
 */

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { LocalNotificationsPlugin as PublishedLocalNotifications } from '@capacitor/local-notifications';
import {
  parseHostReminders,
  type DocBlocksHostNotificationsAPI,
  type HostReminder,
  type NotificationPermission,
  type OpenRequest,
} from '@bendyline/docblocks/host';

type DisplayPermission = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale';

/** The part of `@capacitor/local-notifications` DocBlocks uses. */
export interface LocalNotificationsPlugin {
  checkPermissions(): Promise<{ display: DisplayPermission }>;
  requestPermissions(): Promise<{ display: DisplayPermission }>;
  schedule(options: {
    notifications: Array<{
      id: number;
      title: string;
      body: string;
      schedule: { at: Date; allowWhileIdle?: boolean };
      extra?: Record<string, string>;
    }>;
  }): Promise<unknown>;
  getPending(): Promise<{ notifications: Array<{ id: number }> }>;
  cancel(options: { notifications: Array<{ id: number }> }): Promise<void>;
  addListener(
    event: 'localNotificationActionPerformed',
    listener: (action: { notification: { extra?: unknown } }) => void,
  ): Promise<PluginListenerHandle>;
}

export const LOCAL_NOTIFICATIONS_PLUGIN = 'LocalNotifications';

function permission(display: DisplayPermission): NotificationPermission {
  return display === 'granted' ? 'available' : display === 'denied' ? 'denied' : 'prompt';
}

/** A positive 31-bit id for a reminder, as the plugin wants. */
export function notificationId(reminderId: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < reminderId.length; index += 1) {
    value ^= reminderId.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 1 || 1;
}

/** The document a tapped notification names, or null when it names none. */
export function openRequestFromExtra(extra: unknown): OpenRequest | null {
  if (typeof extra !== 'object' || extra === null) return null;
  const { workspaceId, path } = extra as Record<string, unknown>;
  if (typeof workspaceId !== 'string' || typeof path !== 'string' || !workspaceId || !path) {
    return null;
  }
  if (path.startsWith('/') || path.split('/').some((part) => part === '' || part === '..')) {
    return null;
  }
  return { kind: 'workspace-file', workspaceId, path: `/${path}` };
}

export function createMobileNotifications(
  plugin: LocalNotificationsPlugin,
  onOpen: (request: OpenRequest) => void,
): DocBlocksHostNotificationsAPI {
  void plugin
    .addListener('localNotificationActionPerformed', (action) => {
      const request = openRequestFromExtra(action.notification.extra);
      if (request) onOpen(request);
    })
    .catch(() => undefined);
  return {
    status: async () => permission((await plugin.checkPermissions()).display),
    requestPermission: async () => permission((await plugin.requestPermissions()).display),
    syncReminders: async (value) => {
      const reminders: HostReminder[] = parseHostReminders(value);
      // Every pending notification is one of ours: replace the whole set.
      const pending = (await plugin.getPending()).notifications;
      if (pending.length > 0) {
        await plugin.cancel({ notifications: pending.map(({ id }) => ({ id })) });
      }
      const now = Date.now();
      const upcoming = reminders.filter((reminder) => Date.parse(reminder.at) > now);
      if (upcoming.length === 0) return;
      await plugin.schedule({
        notifications: upcoming.map((reminder) => ({
          id: notificationId(reminder.id),
          title: reminder.title,
          body: reminder.body,
          schedule: { at: new Date(reminder.at), allowWhileIdle: true },
          extra: { workspaceId: reminder.workspaceId, path: reminder.path },
        })),
      });
    },
  };
}

/** The phone's notifications, or null when the app does not include the plugin. */
export function installMobileNotifications(
  onOpen: (request: OpenRequest) => void,
): DocBlocksHostNotificationsAPI | null {
  if (!Capacitor.isPluginAvailable(LOCAL_NOTIFICATIONS_PLUGIN)) return null;
  // Registered under the published type, so a plugin release that changes the
  // part DocBlocks uses fails the typecheck here.
  return createMobileNotifications(
    registerPlugin<PublishedLocalNotifications>(LOCAL_NOTIFICATIONS_PLUGIN),
    onOpen,
  );
}
