import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.js';

/**
 * Reminders reach main through the preload bridge, are kept on disk so a
 * relaunch re-arms them, and a malformed set is refused at the boundary.
 */
test('keeps the reminders the renderer hands over, and refuses a malformed set', async ({
  launchApp,
  userDataDir,
}) => {
  const { window } = await launchApp();
  await window.waitForSelector('.db-shell', { timeout: 30_000 });

  const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const result = await window.evaluate(async (when) => {
    const host = (
      window as unknown as {
        docBlocksHost: {
          notifications: {
            status(): Promise<string>;
            syncReminders(reminders: unknown[]): Promise<void>;
            setBadge(count: number): Promise<void>;
          };
        };
      }
    ).docBlocksHost.notifications;
    const status = await host.status();
    await host.syncReminders([
      {
        id: 'r-e2e',
        at: when,
        title: 'Call Priya',
        body: 'Due today',
        workspaceId: 'w1',
        path: 'Tasks/Active/Call Priya.md',
      },
    ]);
    await host.setBadge(2);
    let refused = false;
    try {
      await host.syncReminders([
        { id: 'x', at: when, title: 't', body: '', workspaceId: 'w', path: '/etc/passwd' },
      ]);
    } catch {
      refused = true;
    }
    return { status, refused };
  }, at);

  expect(['available', 'unavailable']).toContain(result.status);
  expect(result.refused).toBe(true);
  const stored = JSON.parse(fs.readFileSync(path.join(userDataDir, 'reminders.json'), 'utf8')) as {
    reminders: Array<{ id: string; at: string }>;
  };
  expect(stored.reminders).toEqual([expect.objectContaining({ id: 'r-e2e', at })]);
});
