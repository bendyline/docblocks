import { expect } from 'chai';
import {
  createMobileNotifications,
  notificationId,
  openRequestFromExtra,
  type LocalNotificationsPlugin,
} from '../src/notifications.js';

function fakePlugin(display: 'granted' | 'denied' | 'prompt' = 'prompt') {
  const calls: string[] = [];
  let pending: Array<{ id: number }> = [{ id: 7 }];
  let tap: ((action: { notification: { extra?: unknown } }) => void) | null = null;
  const scheduled: Array<{ id: number; title: string; extra?: Record<string, string> }> = [];
  const plugin: LocalNotificationsPlugin = {
    checkPermissions: async () => ({ display }),
    requestPermissions: async () => {
      calls.push('request');
      return { display: 'granted' };
    },
    schedule: async ({ notifications }) => {
      scheduled.push(...notifications);
      pending = notifications.map(({ id }) => ({ id }));
    },
    getPending: async () => ({ notifications: pending }),
    cancel: async ({ notifications }) => {
      calls.push(`cancel ${notifications.map(({ id }) => id).join(',')}`);
      pending = [];
    },
    addListener: async (_event, listener) => {
      tap = listener;
      return { remove: async () => undefined };
    },
  };
  return { plugin, calls, scheduled, tap: (extra: unknown) => tap?.({ notification: { extra } }) };
}

describe('mobile reminders', () => {
  it('reports permission in the shared words and asks only when told to', async () => {
    const fake = fakePlugin('prompt');
    const notifications = createMobileNotifications(fake.plugin, () => undefined);
    expect(await notifications.status()).to.equal('prompt');
    expect(fake.calls).to.deep.equal([]);
    expect(await notifications.requestPermission()).to.equal('available');
    expect(fake.calls).to.deep.equal(['request']);
    expect(notifications.setBadge).to.equal(undefined);
  });

  it('replaces whatever was pending with the new set, skipping reminders already past', async () => {
    const fake = fakePlugin('granted');
    const notifications = createMobileNotifications(fake.plugin, () => undefined);
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    await notifications.syncReminders([
      { id: 'a', at: soon, title: 'Call Priya', body: '', workspaceId: 'w1', path: 'Tasks/a.md' },
      { id: 'b', at: past, title: 'Old', body: '', workspaceId: 'w1', path: 'Tasks/b.md' },
    ]);
    expect(fake.calls).to.deep.equal(['cancel 7']);
    expect(fake.scheduled.map((entry) => entry.title)).to.deep.equal(['Call Priya']);
    expect(fake.scheduled[0]?.id).to.equal(notificationId('a'));
    expect(fake.scheduled[0]?.extra).to.deep.equal({ workspaceId: 'w1', path: 'Tasks/a.md' });
  });

  it('opens the document a tapped reminder names, and nothing for a malformed one', () => {
    const opened: unknown[] = [];
    const fake = fakePlugin('granted');
    createMobileNotifications(fake.plugin, (request) => opened.push(request));
    return Promise.resolve().then(() => {
      fake.tap({ workspaceId: 'w1', path: 'Tasks/a.md' });
      fake.tap({ workspaceId: 'w1', path: '../etc' });
      fake.tap(null);
      expect(opened).to.deep.equal([
        { kind: 'workspace-file', workspaceId: 'w1', path: '/Tasks/a.md' },
      ]);
      expect(openRequestFromExtra({ workspaceId: '', path: 'a.md' })).to.equal(null);
    });
  });

  it('gives each reminder a stable, positive 31-bit id', () => {
    const id = notificationId('r-12345');
    expect(id).to.equal(notificationId('r-12345'));
    expect(id)
      .to.be.greaterThan(0)
      .and.lessThan(2 ** 31);
    expect(notificationId('r-1')).to.not.equal(notificationId('r-2'));
  });
});
