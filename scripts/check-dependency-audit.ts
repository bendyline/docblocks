import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type UnknownRecord = Readonly<Record<string, unknown>>;
type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

export interface AuditFinding {
  readonly advisory: string;
  readonly nodes: readonly string[];
  readonly package: string;
  readonly severity: Severity;
  readonly source: number;
  readonly title: string;
  readonly url: string;
  readonly vulnerableRange: string;
}

/** Advisory ID (`GHSA-…`) → why the build may carry it for now. */
export type AuditExceptions = ReadonlyMap<string, string>;

export interface AuditEvaluation {
  readonly failures: readonly string[];
  /** Informational: nothing to fix now, but worth tidying when convenient. */
  readonly notices: readonly string[];
  readonly findings: readonly AuditFinding[];
}

/**
 * Only critical advisories in shipped dependencies fail the gate. Everything
 * else is reported, so a newly published moderate or high advisory deep in the
 * tree never breaks `npm run all` on the day the database changes.
 */
const blockingSeverity: Severity = 'critical';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exceptionsPath = path.join(repoRoot, 'security', 'audit-exceptions.json');
const reportDirectory = path.join(repoRoot, 'reports', 'dependency-audit');
const rawReportPath = path.join(reportDirectory, 'npm-audit.json');
const markdownReportPath = path.join(reportDirectory, 'dependency-audit.md');
const severityOrder: readonly Severity[] = ['critical', 'high', 'moderate', 'low', 'info'];
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

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function requireSeverity(value: unknown, label: string): Severity {
  if (typeof value !== 'string' || !severityOrder.includes(value as Severity)) {
    throw new Error(`${label} must be a recognized npm severity`);
  }
  return value as Severity;
}

function advisoryIdentifier(url: string, source: number): string {
  return url.match(/GHSA-[0-9A-Za-z-]+/u)?.[0].toUpperCase() ?? `NPM-${source}`;
}

export function normalizeAuditReport(value: unknown): readonly AuditFinding[] {
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
    const nodes = Array.isArray(vulnerabilityValue.nodes)
      ? [...new Set(vulnerabilityValue.nodes.filter((node) => typeof node === 'string'))].sort()
      : [];

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

  return [...findings.values()].sort(
    (left, right) =>
      severityOrder.indexOf(left.severity) - severityOrder.indexOf(right.severity) ||
      `${left.package}\0${left.advisory}`.localeCompare(`${right.package}\0${right.advisory}`),
  );
}

export function parseExceptions(value: unknown): AuditExceptions {
  if (!isRecord(value)) {
    throw new Error('security/audit-exceptions.json must map advisory IDs to reasons');
  }
  const exceptions = new Map<string, string>();
  for (const [advisory, reason] of Object.entries(value)) {
    exceptions.set(advisory.toUpperCase(), requireString(reason, `exception ${advisory}`));
  }
  return exceptions;
}

export function evaluateAudit(report: unknown, exceptionsValue: unknown): AuditEvaluation {
  const findings = normalizeAuditReport(report);
  const exceptions = parseExceptions(exceptionsValue);
  const reported = new Set(findings.map((finding) => finding.advisory));

  const failures = findings
    .filter((finding) => finding.severity === blockingSeverity && !exceptions.has(finding.advisory))
    .map(
      (finding) =>
        `${finding.severity} ${finding.package} ${finding.advisory}: ${finding.title} (${finding.url})`,
    );
  const notices = [...exceptions.keys()]
    .filter((advisory) => !reported.has(advisory))
    .map((advisory) => `npm no longer reports ${advisory}; its exception can be deleted`);

  return { failures, findings, notices };
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
    // `--omit=dev` limits the audit to what ships: build tools, test runners and
    // the pinned npm's own bundled packages never reach a user.
    const child = spawn(process.execPath, [npmCli, 'audit', '--omit=dev', '--json'], {
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

function severityCounts(findings: readonly AuditFinding[]): string {
  return severityOrder
    .filter((severity) => severity !== 'info')
    .map((severity) => {
      const count = findings.filter((finding) => finding.severity === severity).length;
      return `${count} ${severity}`;
    })
    .join(', ');
}

function renderMarkdown(
  evaluation: AuditEvaluation,
  exceptions: AuditExceptions,
  generatedAt: string,
): string {
  const rows = evaluation.findings.map((finding) => {
    const exception = exceptions.get(finding.advisory);
    const status = exception
      ? `excepted: ${exception}`
      : finding.severity === blockingSeverity
        ? 'BLOCKING'
        : 'reported';
    return `| ${markdownCell(finding.package)} | ${finding.severity} | [${finding.advisory}](${finding.url}) | ${markdownCell(finding.vulnerableRange)} | ${markdownCell(finding.title)} | ${markdownCell(status)} |`;
  });
  return [
    '# Dependency audit',
    '',
    `Generated: ${generatedAt}`,
    '',
    `Shipped (non-dev) dependencies: ${evaluation.findings.length} advisories (${severityCounts(evaluation.findings)}). Only ${blockingSeverity} advisories without an exception fail the gate.`,
    '',
    '| Package | Severity | Advisory | Affected | Title | Status |',
    '| --- | --- | --- | --- | --- | --- |',
    ...(rows.length > 0 ? rows : ['| — | — | — | — | No current findings | — |']),
    '',
    ...(evaluation.failures.length > 0
      ? ['## Blocking', '', ...evaluation.failures.map((failure) => `- ${failure}`), '']
      : []),
    ...(evaluation.notices.length > 0
      ? ['## Notices', '', ...evaluation.notices.map((notice) => `- ${notice}`), '']
      : []),
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
  const exceptionsValue = JSON.parse(await readFile(exceptionsPath, 'utf8')) as unknown;
  const evaluation = evaluateAudit(auditValue, exceptionsValue);
  const evidence = path.relative(repoRoot, markdownReportPath);
  await writeFile(
    markdownReportPath,
    renderMarkdown(evaluation, parseExceptions(exceptionsValue), new Date().toISOString()),
    'utf8',
  );

  if (evaluation.failures.length > 0) {
    throw new Error(
      `dependency audit found ${blockingSeverity} advisories in shipped dependencies:\n- ${evaluation.failures.join('\n- ')}\nUpdate the dependency, or add the advisory to security/audit-exceptions.json with a reason. Evidence: ${evidence}`,
    );
  }
  for (const notice of evaluation.notices) process.stderr.write(`notice: ${notice}\n`);
  process.stdout.write(
    `Dependency audit: ${evaluation.findings.length} advisories in shipped dependencies (${severityCounts(evaluation.findings)}); none blocking. Evidence: ${evidence}\n`,
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
