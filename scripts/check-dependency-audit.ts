import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type UnknownRecord = Readonly<Record<string, unknown>>;
type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';
type FindingScope = 'shipped' | 'development-only' | 'toolchain-only';
/**
 * Time-boxed kinds record a risk we are still carrying, so they expire and
 * must be re-reviewed. `patched` records a finding that is fixed but still
 * reported — typically because an advisory's affected range does not credit a
 * backport. A fix does not go stale on a calendar, so a patched disposition has
 * no expiry: it names the test that proves the fix instead, and that test runs
 * in every `npm run all`.
 */
type TimeBoxedKind = 'mitigated' | 'not-shipped' | 'upstream-blocked';
type DispositionKind = TimeBoxedKind | 'patched';

export interface AuditFinding {
  readonly advisory: string;
  readonly isDirect: boolean;
  readonly nodes: readonly string[];
  readonly package: string;
  readonly severity: Severity;
  readonly source: number;
  readonly title: string;
  readonly url: string;
  readonly vulnerableRange: string;
}

interface DispositionBase {
  readonly advisory: string;
  readonly owner: string;
  readonly package: string;
  readonly reason: string;
  readonly remediation: string;
  readonly scope: FindingScope;
  readonly severity: Severity;
}

export interface TimeBoxedDisposition extends DispositionBase {
  readonly classification: TimeBoxedKind;
  readonly expires: string;
}

export interface PatchedDisposition extends DispositionBase {
  readonly classification: 'patched';
  /** Repo-relative path to the test that proves the installed version is fixed. */
  readonly verifiedBy: string;
}

export type AuditDisposition = TimeBoxedDisposition | PatchedDisposition;

export interface DispositionDocument {
  readonly dispositions: readonly AuditDisposition[];
  readonly reviewedAt: string;
  readonly schemaVersion: 1;
}

export interface AuditSummary {
  readonly critical: number;
  readonly high: number;
  readonly info: number;
  readonly low: number;
  readonly moderate: number;
  readonly total: number;
}

export interface AuditEvaluation {
  readonly failures: readonly string[];
  /** Informational: nothing to fix now, but worth tidying when convenient. */
  readonly notices: readonly string[];
  readonly findings: readonly AuditFinding[];
  readonly summary: AuditSummary;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dispositionPath = path.join(repoRoot, 'security', 'dependency-audit-dispositions.json');
const reportDirectory = path.join(repoRoot, 'reports', 'dependency-audit');
const rawReportPath = path.join(reportDirectory, 'npm-audit.json');
const normalizedReportPath = path.join(reportDirectory, 'dependency-audit.json');
const markdownReportPath = path.join(reportDirectory, 'dependency-audit.md');
const severityValues = new Set<Severity>(['info', 'low', 'moderate', 'high', 'critical']);
const scopeValues = new Set<FindingScope>(['shipped', 'development-only', 'toolchain-only']);
const classificationValues = new Set<DispositionKind>([
  'mitigated',
  'not-shipped',
  'upstream-blocked',
  'patched',
]);
const verificationTestPath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+\.test\.ts$/u;
const isoDate = /^\d{4}-\d{2}-\d{2}$/u;
const maximumOutputBytes = 16 * 1024 * 1024;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function requireSeverity(value: unknown, label: string): Severity {
  if (typeof value !== 'string' || !severityValues.has(value as Severity)) {
    throw new Error(`${label} must be a recognized npm severity`);
  }
  return value as Severity;
}

function requireExactKeys(record: UnknownRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must have exactly these fields: ${expected.join(', ')}`);
  }
}

function requireDate(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!isoDate.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date`);
  }
  return result;
}

function advisoryIdentifier(url: string, source: number): string {
  return url.match(/GHSA-[0-9A-Za-z-]+/u)?.[0].toUpperCase() ?? `NPM-${source}`;
}

function parseSummary(value: unknown): AuditSummary {
  if (!isRecord(value) || !isRecord(value.vulnerabilities)) {
    throw new Error('npm audit metadata.vulnerabilities is missing');
  }
  const counts = value.vulnerabilities;
  return {
    info: requireNumber(counts.info, 'npm audit metadata.vulnerabilities.info'),
    low: requireNumber(counts.low, 'npm audit metadata.vulnerabilities.low'),
    moderate: requireNumber(counts.moderate, 'npm audit metadata.vulnerabilities.moderate'),
    high: requireNumber(counts.high, 'npm audit metadata.vulnerabilities.high'),
    critical: requireNumber(counts.critical, 'npm audit metadata.vulnerabilities.critical'),
    total: requireNumber(counts.total, 'npm audit metadata.vulnerabilities.total'),
  };
}

export function normalizeAuditReport(value: unknown): {
  readonly findings: readonly AuditFinding[];
  readonly summary: AuditSummary;
} {
  if (!isRecord(value) || value.auditReportVersion !== 2 || !isRecord(value.vulnerabilities)) {
    throw new Error('npm audit output must be a version 2 JSON report');
  }

  const findings = new Map<string, AuditFinding>();
  for (const [packageKey, vulnerabilityValue] of Object.entries(value.vulnerabilities)) {
    if (!isRecord(vulnerabilityValue) || !Array.isArray(vulnerabilityValue.via)) {
      throw new Error(`npm audit vulnerability ${packageKey} has an invalid shape`);
    }
    const packageName =
      typeof vulnerabilityValue.name === 'string' ? vulnerabilityValue.name : packageKey;
    const isDirect = requireBoolean(
      vulnerabilityValue.isDirect,
      `npm audit vulnerability ${packageName}.isDirect`,
    );
    if (
      !Array.isArray(vulnerabilityValue.nodes) ||
      vulnerabilityValue.nodes.some((node) => typeof node !== 'string')
    ) {
      throw new Error(`npm audit vulnerability ${packageName}.nodes must contain strings`);
    }
    const nodes = [...new Set(vulnerabilityValue.nodes as string[])].sort();

    for (const [viaIndex, viaValue] of vulnerabilityValue.via.entries()) {
      // String entries are dependency fan-out references. The referenced advisory object is
      // normalized at its owning package, so counting the string again would duplicate a finding.
      if (typeof viaValue === 'string') continue;
      if (!isRecord(viaValue)) {
        throw new Error(`npm audit vulnerability ${packageName}.via[${viaIndex}] is invalid`);
      }
      const source = requireNumber(viaValue.source, `${packageName}.via[${viaIndex}].source`);
      const url = requireString(viaValue.url, `${packageName}.via[${viaIndex}].url`);
      const finding: AuditFinding = {
        advisory: advisoryIdentifier(url, source),
        isDirect,
        nodes,
        package: packageName,
        severity: requireSeverity(viaValue.severity, `${packageName}.via[${viaIndex}].severity`),
        source,
        title: requireString(viaValue.title, `${packageName}.via[${viaIndex}].title`),
        url,
        vulnerableRange: requireString(viaValue.range, `${packageName}.via[${viaIndex}].range`),
      };
      findings.set(`${finding.package}\0${finding.source}`, finding);
    }
  }

  return {
    findings: [...findings.values()].sort((left, right) =>
      `${left.package}\0${left.advisory}`.localeCompare(`${right.package}\0${right.advisory}`),
    ),
    summary: parseSummary(value.metadata),
  };
}

export function parseDispositionDocument(value: unknown): DispositionDocument {
  if (!isRecord(value)) throw new Error('dependency audit dispositions must be an object');
  requireExactKeys(value, ['schemaVersion', 'reviewedAt', 'dispositions'], 'disposition document');
  if (value.schemaVersion !== 1 || !Array.isArray(value.dispositions)) {
    throw new Error('dependency audit dispositions must use schemaVersion 1 and an array');
  }

  const dispositions = value.dispositions.map((entry, index): AuditDisposition => {
    if (!isRecord(entry)) throw new Error(`dispositions[${index}] must be an object`);
    const classification = requireString(
      entry.classification,
      `dispositions[${index}].classification`,
    );
    if (!classificationValues.has(classification as DispositionKind)) {
      throw new Error(`dispositions[${index}].classification is invalid`);
    }
    const patched = classification === 'patched';
    requireExactKeys(
      entry,
      [
        'package',
        'advisory',
        'severity',
        'scope',
        'classification',
        'owner',
        patched ? 'verifiedBy' : 'expires',
        'reason',
        'remediation',
      ],
      `dispositions[${index}]`,
    );
    const scope = requireString(entry.scope, `dispositions[${index}].scope`);
    if (!scopeValues.has(scope as FindingScope)) {
      throw new Error(`dispositions[${index}].scope is invalid`);
    }
    const reason = requireString(entry.reason, `dispositions[${index}].reason`);
    const remediation = requireString(entry.remediation, `dispositions[${index}].remediation`);
    if (reason.length < 20 || remediation.length < 20) {
      throw new Error(`dispositions[${index}] reason and remediation must be substantive`);
    }
    const base: DispositionBase = {
      package: requireString(entry.package, `dispositions[${index}].package`),
      advisory: requireString(entry.advisory, `dispositions[${index}].advisory`).toUpperCase(),
      severity: requireSeverity(entry.severity, `dispositions[${index}].severity`),
      scope: scope as FindingScope,
      owner: requireString(entry.owner, `dispositions[${index}].owner`),
      reason,
      remediation,
    };
    if (patched) {
      const verifiedBy = requireString(entry.verifiedBy, `dispositions[${index}].verifiedBy`);
      if (!verificationTestPath.test(verifiedBy)) {
        throw new Error(
          `dispositions[${index}].verifiedBy must be a repo-relative *.test.ts path inside the repository`,
        );
      }
      return { ...base, classification: 'patched', verifiedBy };
    }
    return {
      ...base,
      classification: classification as TimeBoxedKind,
      expires: requireDate(entry.expires, `dispositions[${index}].expires`),
    };
  });

  return {
    schemaVersion: 1,
    reviewedAt: requireDate(value.reviewedAt, 'disposition document reviewedAt'),
    dispositions,
  };
}

function dayDifference(left: string, right: string): number {
  return (Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86_400_000;
}

/**
 * Read a verification test's source, or null when it does not exist. Injected
 * so the policy stays testable without touching the filesystem.
 */
export type VerificationReader = (repoRelativePath: string) => string | null;

export function evaluateAudit(
  report: unknown,
  dispositionsValue: unknown,
  today = new Date().toISOString().slice(0, 10),
  readVerification?: VerificationReader,
): AuditEvaluation {
  const normalized = normalizeAuditReport(report);
  const document = parseDispositionDocument(dispositionsValue);
  const failures: string[] = [];
  const notices: string[] = [];
  const dispositions = new Map<string, AuditDisposition>();

  // The review date only matters while we are carrying a risk. A document of
  // nothing but proven fixes has nothing to re-review on a schedule.
  const carriesRisk = document.dispositions.some(
    (disposition) => disposition.classification !== 'patched',
  );
  if (dayDifference(today, document.reviewedAt) < 0) {
    failures.push(`disposition review date ${document.reviewedAt} is in the future`);
  } else if (carriesRisk && dayDifference(today, document.reviewedAt) > 30) {
    failures.push(`disposition review date ${document.reviewedAt} is more than 30 days old`);
  }

  for (const disposition of document.dispositions) {
    const key = `${disposition.package}\0${disposition.advisory}`;
    if (dispositions.has(key)) {
      failures.push(`duplicate disposition for ${disposition.package} ${disposition.advisory}`);
    }
    dispositions.set(key, disposition);
    if (disposition.classification === 'patched') {
      if (readVerification) {
        const source = readVerification(disposition.verifiedBy);
        if (source === null) {
          failures.push(
            `patched disposition for ${disposition.package} ${disposition.advisory} names a missing test: ${disposition.verifiedBy}`,
          );
        } else if (!source.toUpperCase().includes(disposition.advisory)) {
          failures.push(
            `patched disposition for ${disposition.package} ${disposition.advisory} names a test that does not cite the advisory: ${disposition.verifiedBy}`,
          );
        }
      }
      continue;
    }
    if (dayDifference(disposition.expires, today) <= 0) {
      failures.push(
        `disposition for ${disposition.package} ${disposition.advisory} expired on ${disposition.expires}`,
      );
    } else if (dayDifference(disposition.expires, today) > 30) {
      failures.push(
        `disposition for ${disposition.package} ${disposition.advisory} expires more than 30 days from review`,
      );
    }
  }

  const currentKeys = new Set<string>();
  for (const finding of normalized.findings) {
    const key = `${finding.package}\0${finding.advisory}`;
    currentKeys.add(key);
    const disposition = dispositions.get(key);
    if (!disposition) {
      failures.push(`missing disposition for ${finding.package} ${finding.advisory}`);
      continue;
    }
    if (disposition.severity !== finding.severity) {
      failures.push(
        `severity drift for ${finding.package} ${finding.advisory}: audit=${finding.severity}, disposition=${disposition.severity}`,
      );
    }
    if (disposition.scope === 'shipped' && ['high', 'critical'].includes(finding.severity)) {
      failures.push(
        `${finding.severity} finding ${finding.package} ${finding.advisory} affects shipped code and cannot be dispositioned`,
      );
    }
    if (finding.severity === 'critical') {
      failures.push(`critical finding ${finding.package} ${finding.advisory} is release-blocking`);
    }
  }

  for (const disposition of document.dispositions) {
    const key = `${disposition.package}\0${disposition.advisory}`;
    if (currentKeys.has(key)) continue;
    if (disposition.classification === 'patched') {
      // Usually the advisory was corrected to credit the fix. Nothing is
      // wrong, so this must not fail a build on the day the database changes.
      notices.push(
        `npm no longer reports ${disposition.package} ${disposition.advisory}; its patched disposition can be deleted`,
      );
    } else {
      failures.push(`stale disposition for ${disposition.package} ${disposition.advisory}`);
    }
  }

  return { ...normalized, failures, notices };
}

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function runAudit(): Promise<CommandResult> {
  const npmCli = path.join(repoRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return await new Promise<CommandResult>((resolve, reject) => {
    // Invoke the repository-pinned npm through Node. This avoids Windows .cmd shell
    // interpretation and guarantees that the audit uses the governed toolchain.
    const child = spawn(process.execPath, [npmCli, 'audit', '--json'], {
      cwd: repoRoot,
      env: process.env,
      shell: false,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > maximumOutputBytes) {
        child.kill();
        reject(new Error('npm audit output exceeded the 16 MiB safety budget'));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function renderMarkdown(
  evaluation: AuditEvaluation,
  document: DispositionDocument,
  generatedAt: string,
): string {
  const dispositionByKey = new Map(
    document.dispositions.map((entry) => [`${entry.package}\0${entry.advisory}`, entry]),
  );
  const rows = evaluation.findings.map((finding) => {
    const disposition = dispositionByKey.get(`${finding.package}\0${finding.advisory}`);
    const expiry = !disposition
      ? 'MISSING'
      : disposition.classification === 'patched'
        ? `never (verified by \`${disposition.verifiedBy}\`)`
        : disposition.expires;
    return `| ${markdownCell(finding.package)} | ${finding.severity} | [${finding.advisory}](${finding.url}) | ${disposition?.scope ?? 'MISSING'} | ${disposition?.classification ?? 'MISSING'} | ${markdownCell(expiry)} | ${markdownCell(disposition?.reason ?? 'No disposition')} |`;
  });
  return [
    '# Dependency audit evidence',
    '',
    `Generated: ${generatedAt}`,
    '',
    `npm summary: ${evaluation.summary.total} vulnerable dependency entries (${evaluation.summary.critical} critical, ${evaluation.summary.high} high, ${evaluation.summary.moderate} moderate, ${evaluation.summary.low} low, ${evaluation.summary.info} info).`,
    '',
    `Normalized advisory findings: ${evaluation.findings.length}. Policy failures: ${evaluation.failures.length}.`,
    '',
    '| Package | Severity | Advisory | Scope | Disposition | Expires | Rationale |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...(rows.length > 0 ? rows : ['| — | — | — | — | — | — | No current findings |']),
    '',
    '## Policy result',
    '',
    ...(evaluation.failures.length > 0
      ? evaluation.failures.map((failure) => `- FAIL: ${failure}`)
      : [
          'PASS: every current finding has a current disposition and no blocking shipped-code finding remains.',
        ]),
    ...(evaluation.notices.length > 0
      ? ['', '## Notices', '', ...evaluation.notices.map((notice) => `- ${notice}`)]
      : []),
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  await mkdir(reportDirectory, { recursive: true });
  const auditResult = await runAudit();
  await writeFile(rawReportPath, `${auditResult.stdout.trimEnd()}\n`, 'utf8');
  if (![0, 1].includes(auditResult.exitCode)) {
    throw new Error(
      `npm audit failed operationally with exit ${auditResult.exitCode}: ${auditResult.stderr.trim()}`,
    );
  }

  let auditValue: unknown;
  try {
    auditValue = JSON.parse(auditResult.stdout) as unknown;
  } catch {
    throw new Error(`npm audit did not return JSON: ${auditResult.stderr.trim()}`);
  }
  const dispositionsValue = JSON.parse(await readFile(dispositionPath, 'utf8')) as unknown;
  const document = parseDispositionDocument(dispositionsValue);
  const evaluation = evaluateAudit(auditValue, dispositionsValue, undefined, (relativePath) => {
    const absolute = path.join(repoRoot, relativePath);
    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
  });
  const generatedAt = new Date().toISOString();
  await writeFile(
    normalizedReportPath,
    `${JSON.stringify({ schemaVersion: 1, generatedAt, ...evaluation, dispositions: document }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(markdownReportPath, renderMarkdown(evaluation, document, generatedAt), 'utf8');

  if (evaluation.failures.length > 0) {
    throw new Error(
      `dependency audit policy failed:\n- ${evaluation.failures.join('\n- ')}\nEvidence: ${path.relative(repoRoot, markdownReportPath)}`,
    );
  }
  for (const notice of evaluation.notices) process.stderr.write(`notice: ${notice}\n`);
  process.stdout.write(
    `Dependency audit retained ${evaluation.findings.length} advisory dispositions (${evaluation.summary.total} npm dependency entries) in ${path.relative(repoRoot, reportDirectory)}.\n`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
