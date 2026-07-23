import { expect } from 'chai';
import { formatFriendlyLastModified } from '../src/FileExplorer/last-modified.js';

describe('friendly last-modified formatting', () => {
  const now = Date.parse('2026-07-22T12:00:00.000Z');

  it('uses compact relative labels for recent timestamps', () => {
    expect(formatFriendlyLastModified('2026-07-22T11:59:45.000Z', now)?.shortLabel).to.equal('Now');
    expect(formatFriendlyLastModified('2026-07-22T11:55:00.000Z', now)?.shortLabel).to.equal(
      '5m ago',
    );
    expect(formatFriendlyLastModified('2026-07-22T09:00:00.000Z', now)?.shortLabel).to.equal(
      '3h ago',
    );
    expect(formatFriendlyLastModified('2026-07-21T00:00:00.000Z', now)?.shortLabel).to.equal(
      'Yesterday',
    );
  });

  it('falls back to a calendar date for older timestamps', () => {
    const formatted = formatFriendlyLastModified('2026-06-01T12:00:00.000Z', now);
    expect(formatted?.shortLabel).to.match(/Jun.*1|1.*Jun/u);
    expect(formatted?.title).to.match(/^Last modified /);
  });

  it('omits missing and invalid timestamps', () => {
    expect(formatFriendlyLastModified(undefined, now)).to.equal(null);
    expect(formatFriendlyLastModified('not-a-date', now)).to.equal(null);
  });
});
