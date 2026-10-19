import { expect } from 'chai';
import {
  AI_REPORT_OUTPUT_CHARACTERS,
  buildAiOutputReportUrl,
  buildIssueReportUrl,
} from '../src/DocBlocksShell/issue-report.js';

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

describe('AI output report link', () => {
  const base = {
    feature: 'Rewrite selection',
    reason: 'harmful' as const,
    model: 'Qwen 3.5 0.8B',
    details: '',
    output: null,
    reportedAt: new Date(2026, 9, 17),
    version: '2.7.2 iOS',
    userAgent: 'Test Browser',
  };

  it('prefills the reason, feature and model, and leaves the response out by default', () => {
    const url = new URL(buildAiOutputReportUrl(base));
    const body = url.searchParams.get('body') ?? '';

    expect(url.pathname).to.equal('/bendyline/docblocks/issues/new');
    expect(url.searchParams.get('title')).to.equal('AI output report: Offensive or harmful');
    expect(body).to.include('- Feature: Rewrite selection');
    expect(body).to.include('- Model: Qwen 3.5 0.8B');
    expect(body).to.include('<!-- What was wrong with the response? -->');
    expect(body).to.not.include('## AI response');
    expect(body).to.include('- DocBlocks: 2.7.2 iOS');
  });

  it('bounds an included response and fences it so its backticks cannot escape', () => {
    const output = `Text with \`\`\`\` fences ${'y'.repeat(3_000)}`;
    const body =
      new URL(
        buildAiOutputReportUrl({ ...base, details: ' Rude reply ', output }),
      ).searchParams.get('body') ?? '';

    expect(body).to.include('## Details\n\nRude reply\n');
    expect(body).to.include(
      `\`\`\`\`\`text\n${output.slice(0, AI_REPORT_OUTPUT_CHARACTERS)}\n\`\`\`\`\`\n`,
    );
    expect(body).to.not.include('y'.repeat(AI_REPORT_OUTPUT_CHARACTERS));
  });

  it('names an unknown model rather than leaving the line blank', () => {
    const body =
      new URL(buildAiOutputReportUrl({ ...base, model: null, reason: 'other' })).searchParams.get(
        'body',
      ) ?? '';
    expect(body).to.include('- Reason: Something else');
    expect(body).to.include('- Model: unknown');
  });
});
