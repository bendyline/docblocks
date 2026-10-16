import { expect } from 'chai';
import { buildIssueReportUrl } from '../src/DocBlocksShell/issue-report.js';

describe('issue report link', () => {
  it('prefills an editable GitHub issue with bounded environment metadata', () => {
    const url = new URL(
      buildIssueReportUrl({
        reportedAt: new Date(2026, 6, 14, 19, 42),
        version: '1.1.2 web\nignored line',
        userAgent: `Test Browser\r\n${'x'.repeat(2_000)}`,
      }),
    );

    expect(url.origin).to.equal('https://github.com');
    expect(url.pathname).to.equal('/bendyline/docblocks/issues/new');
    expect(url.searchParams.get('body')).to.equal(
      [
        '## Description',
        '',
        '<!-- What happened, and what did you expect? -->',
        '',
        '## Environment',
        '',
        '- Date: 2026-07-14',
        '- DocBlocks: 1.1.2 web ignored line',
        `- User agent: ${`Test Browser ${'x'.repeat(2_000)}`.slice(0, 512)}`,
      ].join('\n'),
    );
  });

  it('uses readable fallbacks for missing values', () => {
    const url = new URL(
      buildIssueReportUrl({
        reportedAt: new Date(2026, 6, 14),
        version: '  ',
        userAgent: '',
      }),
    );
    const body = url.searchParams.get('body');

    expect(body).to.include('- DocBlocks: unknown');
    expect(body).to.include('- User agent: unavailable');
  });

  it("dates the report by the reporter's own calendar day, not UTC's", () => {
    // 11:30 pm local: the UTC day is already tomorrow anywhere west of
    // Greenwich, which is how a report filed on the 15th said the 16th.
    const url = new URL(
      buildIssueReportUrl({
        reportedAt: new Date(2026, 9, 15, 23, 30),
        version: '2.7.1 web',
        userAgent: 'Test Browser',
      }),
    );
    expect(url.searchParams.get('body')).to.include('- Date: 2026-10-15');
  });
});
