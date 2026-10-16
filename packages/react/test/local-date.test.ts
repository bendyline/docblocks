/**
 * Dates shown to a person are their own calendar day. `toISOString()` is the
 * UTC day, which reads as tomorrow every evening west of Greenwich.
 */
import { expect } from 'chai';
import { displayBuildDate, localDateStamp } from '../src/local-date.js';

describe('local dates', () => {
  it('stamps the local calendar day, zero-padded', () => {
    expect(localDateStamp(new Date(2026, 9, 15, 23, 30))).to.equal('2026-10-15');
    expect(localDateStamp(new Date(2026, 0, 5, 0, 5))).to.equal('2026-01-05');
  });

  it('shows a build timestamp as the viewer’s local day', () => {
    const lateEvening = new Date(2026, 9, 15, 23, 30);
    expect(displayBuildDate(lateEvening.toISOString())).to.equal('2026-10-15');
  });

  it('shows a bare build date as given rather than shifting it through UTC midnight', () => {
    expect(displayBuildDate('2026-07-15')).to.equal('2026-07-15');
  });

  it('shows an unparseable value as given', () => {
    expect(displayBuildDate('nightly')).to.equal('nightly');
  });
});
