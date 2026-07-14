const NEW_ISSUE_URL = 'https://github.com/bendyline/docblocks/issues/new';
const VERSION_VALUE_LIMIT = 128;
const USER_AGENT_VALUE_LIMIT = 512;

export interface IssueReportEnvironment {
  reportedAt: Date;
  version: string;
  userAgent: string;
}

function normalizeEnvironmentValue(value: string, fallback: string, limit: number): string {
  const normalized = value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, limit);
  return normalized || fallback;
}

/** Build an editable GitHub issue with bounded diagnostics from the current surface. */
export function buildIssueReportUrl(environment: IssueReportEnvironment): string {
  const body = [
    '## Description',
    '',
    '<!-- What happened, and what did you expect? -->',
    '',
    '## Environment',
    '',
    `- Date: ${environment.reportedAt.toISOString().slice(0, 10)}`,
    `- DocBlocks: ${normalizeEnvironmentValue(environment.version, 'unknown', VERSION_VALUE_LIMIT)}`,
    `- User agent: ${normalizeEnvironmentValue(
      environment.userAgent,
      'unavailable',
      USER_AGENT_VALUE_LIMIT,
    )}`,
  ].join('\n');

  const url = new URL(NEW_ISSUE_URL);
  url.searchParams.set('body', body);
  return url.href;
}
