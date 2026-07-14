import { expect } from 'chai';
import { buildIssueReportUrl } from '../src/DocBlocksShell/issue-report.js';

describe('issue report link', () => {
  it('prefills an editable GitHub issue with bounded environment metadata', () => {
    const url = new URL(
      buildIssueReportUrl({
        reportedAt: new Date('2026-07-14T19:42:00.000Z'),
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
        reportedAt: new Date('2026-07-14T00:00:00.000Z'),
        version: '  ',
        userAgent: '',
      }),
    );
    const body = url.searchParams.get('body');

    expect(body).to.include('- DocBlocks: unknown');
    expect(body).to.include('- User agent: unavailable');
  });
});
