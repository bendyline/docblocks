import { SUPPORT_EMAIL_ADDRESS } from '@bendyline/docblocks/host';

import { localDateStamp } from '../local-date.js';

const NEW_ISSUE_URL = 'https://github.com/bendyline/docblocks/issues/new';
const VERSION_VALUE_LIMIT = 128;
const USER_AGENT_VALUE_LIMIT = 512;
export const AI_REPORT_DETAILS_CHARACTERS = 1_000;
/** Bounded so a prefilled report stays well inside GitHub's URL length limit. */
export const AI_REPORT_OUTPUT_CHARACTERS = 1_500;

export interface IssueReportEnvironment {
  reportedAt: Date;
  version: string;
  userAgent: string;
}

export type AiOutputReportReason = 'harmful' | 'inaccurate' | 'other';

export const AI_OUTPUT_REPORT_REASONS: Readonly<Record<AiOutputReportReason, string>> = {
  harmful: 'Offensive or harmful',
  inaccurate: 'Inaccurate or misleading',
  other: 'Something else',
};

export interface AiOutputReport extends IssueReportEnvironment {
  /** The AI action that produced the response, such as "Rewrite selection". */
  feature: string;
  reason: AiOutputReportReason;
  model: string | null;
  details: string;
  /** The AI's response, present only when the reporter chose to include it. */
  output: string | null;
}

function normalizeEnvironmentValue(value: string, fallback: string, limit: number): string {
  const normalized = value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, limit);
  return normalized || fallback;
}

function environmentLines(environment: IssueReportEnvironment): string[] {
  return [
    '## Environment',
    '',
    `- Date: ${localDateStamp(environment.reportedAt)}`,
    `- DocBlocks: ${normalizeEnvironmentValue(environment.version, 'unknown', VERSION_VALUE_LIMIT)}`,
    `- User agent: ${normalizeEnvironmentValue(
      environment.userAgent,
      'unavailable',
      USER_AGENT_VALUE_LIMIT,
    )}`,
  ];
}

/** A code fence longer than any backtick run in `text`, so the text cannot close it. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Build an editable GitHub issue with bounded diagnostics from the current surface. */
export function buildIssueReportUrl(environment: IssueReportEnvironment): string {
  const body = [
    '## Description',
    '',
    '<!-- What happened, and what did you expect? -->',
    '',
    ...environmentLines(environment),
  ].join('\n');

  const url = new URL(NEW_ISSUE_URL);
  url.searchParams.set('body', body);
  return url.href;
}

/** The report text, with `noDetails` standing in when the reporter wrote none. */
function aiOutputReportBody(report: AiOutputReport, noDetails: string): string {
  const details = report.details.trim().slice(0, AI_REPORT_DETAILS_CHARACTERS);
  const output = report.output?.trim().slice(0, AI_REPORT_OUTPUT_CHARACTERS) ?? '';
  const fence = fenceFor(output);
  return [
    '## AI output report',
    '',
    `- Reason: ${AI_OUTPUT_REPORT_REASONS[report.reason]}`,
    `- Feature: ${normalizeEnvironmentValue(report.feature, 'unknown', VERSION_VALUE_LIMIT)}`,
    `- Model: ${normalizeEnvironmentValue(report.model ?? '', 'unknown', VERSION_VALUE_LIMIT)}`,
    '',
    '## Details',
    '',
    details || noDetails,
    '',
    ...(output ? ['## AI response', '', `${fence}text`, output, fence, ''] : []),
    ...environmentLines(report),
  ].join('\n');
}

/** Build an editable, public GitHub issue that reports one AI response. */
export function buildAiOutputReportUrl(report: AiOutputReport): string {
  const url = new URL(NEW_ISSUE_URL);
  url.searchParams.set('title', `AI output report: ${AI_OUTPUT_REPORT_REASONS[report.reason]}`);
  url.searchParams.set(
    'body',
    aiOutputReportBody(report, '<!-- What was wrong with the response? -->'),
  );
  return url.href;
}

/** Build an editable email to support that reports one AI response privately. */
export function buildAiOutputReportEmailUrl(report: AiOutputReport): string {
  const subject = `DocBlocks AI output report: ${AI_OUTPUT_REPORT_REASONS[report.reason]}`;
  // RFC 6068: line breaks are CRLF, and spaces are %20; a `+` stays a literal plus.
  const body = aiOutputReportBody(report, '(none given)').replace(/\r?\n/g, '\r\n');
  return `mailto:${SUPPORT_EMAIL_ADDRESS}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
