import { expect } from 'chai';
import { parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import {
  parseHostReminders,
  type DocBlocksHostNotificationsAPI,
  type HostReminder,
} from '@bendyline/docblocks/host';
import { reminderBadgeCount, reminderInstant, remindersFor } from '../src/Tasks/reminders.js';
import type { TaskItem } from '../src/Tasks/task-model.js';
import { useReminderSync } from '../src/Home/useReminderSync.js';
import { advanceTime, renderHook } from './helpers/renderHook.js';

function task(path: string, fields: Partial<TaskItem> = {}): TaskItem {
  return {
    workspaceId: 'w1',
    path: parseWorkspacePath(path),
    title: path.replace(/^.*\//, '').replace(/\.md$/, ''),
    done: false,
    folder: null,
    bucket: null,
    group: '',
    pending: false,
    lastModified: '',
    ...fields,
  };
}

describe('task reminders', () => {
  // 08:30 local on Monday 23 November.
  const now = new Date(2026, 10, 23, 8, 30);
  const today = '2026-11-23';
  const names = new Map([
    ['w1', 'Personal'],
    ['w2', 'Work'],
  ]);

  it('reminds at a timed task’s time, and at the chosen time for a day', () => {
    expect(reminderInstant('2026-11-23T15:30', '09:00').getTime()).to.equal(
      new Date(2026, 10, 23, 15, 30).getTime(),
    );
    expect(reminderInstant('2026-11-24', '07:45').getTime()).to.equal(
      new Date(2026, 10, 24, 7, 45).getTime(),
    );
  });

  it('schedules open tasks coming due in the next two weeks, soonest first', () => {
    const reminders = remindersFor(
      [
        task('a.md', { due: '2026-11-23' }),
        task('b.md', { due: '2026-11-23T08:00' }),
        task('c.md', { due: '2026-11-23T16:00', workspaceId: 'w2' }),
        task('d.md', { due: '2026-11-24' }),
        task('e.md', { due: '2026-11-25', done: true }),
        task('f.md', { due: '2026-12-20' }),
        task('g.md'),
      ],
      { now, today, allDayTime: '09:00', workspaceNames: names },
    );
    expect(reminders.map((entry) => entry.title)).to.deep.equal(['a', 'c', 'd']);
    expect(reminders[1]?.body).to.equal('Due today at 16:00 · Work');
    expect(reminders[2]?.body).to.equal('Due tomorrow · Personal');
    // What the host will accept, and stable ids for the same task and time.
    expect(parseHostReminders(reminders)).to.have.length(3);
    const again = remindersFor([task('a.md', { due: '2026-11-23' })], {
      now,
      today,
      allDayTime: '09:00',
      workspaceNames: names,
    });
    expect(again[0]?.id).to.equal(reminders[0]?.id);
  });

  it('caps the set at what the host keeps', () => {
    const many = Array.from({ length: 100 }, (_, n) =>
      task(`t${n}.md`, { due: `2026-11-${String(24 + (n % 5)).padStart(2, '0')}` }),
    );
    expect(
      remindersFor(many, { now, today, allDayTime: '09:00', workspaceNames: names }),
    ).to.have.length(64);
  });

  it('counts what is overdue or due today for the app icon', () => {
    expect(
      reminderBadgeCount(
        [
          task('a.md', { due: '2026-11-20' }),
          task('b.md', { due: '2026-11-23T18:00' }),
          task('c.md', { due: '2026-11-24' }),
          task('d.md', { due: '2026-11-22', done: true }),
        ],
        today,
      ),
    ).to.equal(2);
  });
});

describe('keeping the host’s reminders in step', () => {
  // Within the next two weeks of the real clock, which the hook reads.
  const soon = new Date(Date.now() + 2 * 86_400_000);
  const due = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;

  function notifications() {
    const sent: (readonly HostReminder[])[] = [];
    const api: DocBlocksHostNotificationsAPI = {
      status: async () => 'available',
      requestPermission: async () => 'available',
      syncReminders: async (reminders) => {
        sent.push(reminders);
      },
    };
    return { api, sent };
  }

  it('keeps the host’s set while the tasks are unknown, and cancels it only when turned off', async () => {
    const { api, sent } = notifications();
    const props = {
      notifications: api,
      enabled: true,
      allDayTime: '09:00',
      items: [task('Tasks/Active/Call the plumber.md', { due })],
      workspaceNames: new Map<string, string>(),
      today: due,
      ready: false,
      debounceMs: 0,
    };
    const hook = await renderHook(useReminderSync, props);
    await advanceTime(5);
    expect(sent).to.deep.equal([]);
    await hook.rerender({ ...props, ready: true });
    await advanceTime(5);
    expect(sent.map((set) => set.map((reminder) => reminder.title))).to.deep.equal([
      ['Call the plumber'],
    ]);
    // A loose file opened from the OS: no tasks can be read, and none are cancelled.
    await hook.rerender({ ...props, ready: false, items: [] });
    await advanceTime(5);
    expect(sent).to.have.length(1);
    await hook.rerender({ ...props, ready: false, items: [], enabled: false });
    await advanceTime(5);
    expect(sent.at(-1)).to.deep.equal([]);
    await hook.unmount();
  });
});
