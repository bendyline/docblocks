import { expect } from 'chai';
import {
  NOTIFICATION_LIMITS,
  parseBadgeCount,
  parseHostReminders,
  parseNotificationPermission,
} from '../src/host/index.js';

const reminder = {
  id: 'r-1',
  at: '2026-11-24T09:00:00.000Z',
  title: 'Call Priya',
  body: 'Due tomorrow',
  workspaceId: 'w1',
  path: 'Tasks/Active/Call Priya.md',
};

describe('host notifications contract', () => {
  it('accepts a bounded list of exact reminders', () => {
    expect(parseHostReminders([reminder])).to.deep.equal([reminder]);
    expect(parseHostReminders([{ ...reminder, body: '' }])[0]?.body).to.equal('');
    expect(parseHostReminders([{ ...reminder, at: '2026-11-24T09:00+01:00' }])).to.have.length(1);
  });

  it('refuses anything else', () => {
    const bad: unknown[] = [
      null,
      {},
      [{ ...reminder, extra: 1 }],
      [{ ...reminder, at: 'tomorrow' }],
      [{ ...reminder, at: '2026-11-24 09:00' }],
      [{ ...reminder, title: '' }],
      [{ ...reminder, title: 'x'.repeat(NOTIFICATION_LIMITS.maxTitleCharacters + 1) }],
      [{ ...reminder, title: 'bell\u0007' }],
      [{ ...reminder, path: '/abs.md' }],
      [{ ...reminder, path: 'a/../b.md' }],
      [reminder, reminder],
      new Array(NOTIFICATION_LIMITS.maxReminders + 1)
        .fill(0)
        .map((_, n) => ({ ...reminder, id: `r-${n}` })),
    ];
    for (const value of bad) expect(() => parseHostReminders(value)).to.throw(TypeError);
  });

  it('parses permissions and badge counts', () => {
    expect(parseNotificationPermission('prompt')).to.equal('prompt');
    expect(() => parseNotificationPermission('granted')).to.throw(TypeError);
    expect(parseBadgeCount(3)).to.equal(3);
    expect(parseBadgeCount(1_000_000)).to.equal(NOTIFICATION_LIMITS.maxBadge);
    expect(() => parseBadgeCount(-1)).to.throw(TypeError);
    expect(() => parseBadgeCount(1.5)).to.throw(TypeError);
  });
});
