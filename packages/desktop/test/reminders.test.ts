import { expect } from 'chai';
import type { HostReminder } from '@bendyline/docblocks/host';
import { ReminderScheduler, type ReminderNotice, type StoredReminders } from '../main/reminders.js';

const HOUR = 3_600_000;
const START = Date.parse('2026-11-23T08:00:00.000Z');

function reminder(id: string, offsetMs: number, title = id): HostReminder {
  return {
    id,
    at: new Date(START + offsetMs).toISOString(),
    title,
    body: 'Due today',
    workspaceId: 'w1',
    path: `Tasks/Active/${id}.md`,
  };
}

/** A clock and timers the test moves by hand, and a store kept in memory. */
function harness(initial: unknown = null) {
  let now = START;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let next = 1;
  let stored: unknown = initial;
  const shown: ReminderNotice[] = [];
  const scheduler = new ReminderScheduler({
    store: {
      read: async () => stored,
      write: async (state: StoredReminders) => {
        stored = JSON.parse(JSON.stringify(state));
      },
    },
    show: (notice) => shown.push(notice),
    now: () => now,
    setTimer: (callback, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer: (handle) => timers.delete(handle as number),
  });
  return {
    scheduler,
    shown,
    stored: () => stored,
    advance: async (ms: number) => {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    /** The computer sleeps: the clock moves, and no timer runs. */
    sleep: (ms: number) => {
      now += ms;
    },
    armed: () => timers.size,
    /** How long until the next timer runs. */
    nextIn: () => Math.min(...[...timers.values()].map((timer) => timer.at - now)),
  };
}

describe('desktop reminders', () => {
  it('fires each reminder once at its time, and keeps the set on disk', async () => {
    const h = harness();
    await h.scheduler.start();
    await h.scheduler.sync([reminder('a', HOUR), reminder('b', 2 * HOUR)]);
    expect(h.armed()).to.equal(1);
    await h.advance(HOUR);
    expect(h.shown.map((notice) => notice.title)).to.deep.equal(['a']);
    expect(h.shown[0]?.reminder?.path).to.equal('Tasks/Active/a.md');
    // Re-sending the same set does not fire what already fired.
    await h.scheduler.sync([reminder('a', HOUR), reminder('b', 2 * HOUR)]);
    await h.advance(HOUR);
    expect(h.shown.map((notice) => notice.title)).to.deep.equal(['a', 'b']);
    expect((h.stored() as StoredReminders).fired.sort()).to.deep.equal(['a', 'b']);
  });

  it('cancels reminders left out of a new set', async () => {
    const h = harness();
    await h.scheduler.start();
    await h.scheduler.sync([reminder('a', HOUR)]);
    await h.scheduler.sync([]);
    await h.advance(2 * HOUR);
    expect(h.shown).to.deep.equal([]);
    expect(h.scheduler.pending()).to.deep.equal([]);
  });

  it('shows once, on relaunch, what came due while the app was closed', async () => {
    const one = harness({ version: 1, reminders: [reminder('a', -HOUR)], fired: [] });
    await one.scheduler.start();
    expect(one.shown.map((notice) => notice.title)).to.deep.equal(['a']);

    const many = harness({
      version: 1,
      reminders: [
        reminder('a', -3 * HOUR),
        reminder('b', -2 * HOUR),
        reminder('c', -HOUR),
        reminder('d', HOUR),
      ],
      fired: ['a'],
    });
    await many.scheduler.start();
    expect(many.shown).to.have.length(1);
    expect(many.shown[0]).to.deep.include({ title: '2 tasks came due', reminder: null });
    expect(many.shown[0]?.body).to.equal('b, c');
    // The future one is still armed, and nothing is shown twice on the next launch.
    expect(many.armed()).to.equal(1);
    const again = harness(many.stored());
    await again.scheduler.start();
    expect(again.shown).to.deep.equal([]);
  });

  it('ignores a damaged store and refuses a malformed set', async () => {
    const h = harness({ version: 1, reminders: 'nope', fired: [] });
    await h.scheduler.start();
    expect(h.scheduler.pending()).to.deep.equal([]);
    let failure: unknown;
    try {
      await h.scheduler.sync([{ ...reminder('a', HOUR), path: '/etc/passwd' }]);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(TypeError);
  });

  it('reads the clock at least once a minute, and drops reminders beyond the horizon', async () => {
    const h = harness();
    await h.scheduler.start();
    await h.scheduler.sync([reminder('far', 30 * 24 * HOUR), reminder('beyond', 90 * 24 * HOUR)]);
    expect(h.scheduler.pending().map((entry) => entry.id)).to.deep.equal(['far']);
    expect(h.armed()).to.equal(1);
    expect(h.nextIn()).to.equal(60_000);
    h.scheduler.dispose();
    expect(h.armed()).to.equal(0);
  });

  it('shows on waking what came due while the computer slept', async () => {
    const h = harness();
    await h.scheduler.start();
    await h.scheduler.sync([reminder('a', HOUR), reminder('b', 10 * HOUR)]);
    h.sleep(3 * HOUR);
    h.scheduler.wake();
    expect(h.shown.map((notice) => notice.title)).to.deep.equal(['a']);
    // Without the wake event, the next timer reads the clock within a minute.
    h.sleep(8 * HOUR);
    await h.advance(60_000);
    expect(h.shown.map((notice) => notice.title)).to.deep.equal(['a', 'b']);
    expect((h.stored() as StoredReminders).fired.sort()).to.deep.equal(['a', 'b']);
  });

  it('does not lose a reminder missed in sleep when the next set leaves it out', async () => {
    const h = harness();
    await h.scheduler.start();
    await h.scheduler.sync([reminder('a', HOUR)]);
    h.sleep(2 * HOUR);
    // The renderer leaves out reminders whose time has passed.
    await h.scheduler.sync([]);
    expect(h.shown.map((notice) => notice.title)).to.deep.equal(['a']);
    expect(h.scheduler.pending()).to.deep.equal([]);
  });

  it('writes the kept set one save at a time, last state last', async () => {
    let active = 0;
    let most = 0;
    const saved: number[] = [];
    const scheduler = new ReminderScheduler({
      store: {
        read: async () => null,
        write: async (state: StoredReminders) => {
          active += 1;
          most = Math.max(most, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          saved.push(state.reminders.length);
          active -= 1;
        },
      },
      show: () => undefined,
      now: () => START,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    await scheduler.start();
    await Promise.all([
      scheduler.sync([reminder('a', HOUR)]),
      scheduler.sync([reminder('a', HOUR), reminder('b', 2 * HOUR)]),
    ]);
    expect(most).to.equal(1);
    expect(saved).to.deep.equal([0, 1, 2]);
  });
});
