import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { judgeArtifact } from './artifact-judge.js';
import { EVAL_PROMPT_PROFILES } from './cases.js';
import {
  LLM_JUDGE_CONTRACT_VERSION,
  runGeneration,
  runLlmJudge,
  type CodexHostOptions,
} from './codex-host.js';
import { judgeMarkdown, summarizeChecks } from './markdown-judge.js';
import { writeRunReport } from './report.js';
import { LLM_JUDGE_OUTPUT_SCHEMA } from './schemas.js';
import { resolveCodexCommand, runCapturedProcess } from './subprocess.js';
import type {
  EvalCase,
  EvalCaseResult,
  EvalJudgeMode,
  EvalPromptProfile,
  EvalRunProvenance,
  EvalRunResult,
  LlmJudgeResult,
  StaticJudgeResult,
} from './types.js';

export interface RunEvalOptions {
  readonly label: string;
  readonly suite: string;
  readonly cases: readonly EvalCase[];
  readonly profile: EvalPromptProfile;
  readonly judgeMode: EvalJudgeMode;
  readonly threshold: number;
  readonly model: string | null;
  readonly codexCommand: string;
  readonly repoRoot: string;
  readonly cliEntry: string;
  readonly reportsDirectory: string;
  readonly failFast: boolean;
}

export async function runEval(options: RunEvalOptions): Promise<{
  readonly directory: string;
  readonly run: EvalRunResult;
}> {
  const startedAt = new Date();
  const runId = `${timestampId(startedAt)}-${sanitizeLabel(options.label)}`;
  const directory = path.join(options.reportsDirectory, runId);
  await mkdir(options.reportsDirectory, { recursive: true });
  await mkdir(directory, { recursive: false });
  const codexVersion = await getCodexVersion(options.codexCommand, options.repoRoot);
  const git = await getGitProvenance(options.repoRoot);
  const cliSha256 = sha256(await readFile(options.cliEntry));
  const profileSha256 = sha256(EVAL_PROMPT_PROFILES[options.profile]);
  const judgeContractSha256 = sha256(
    `${LLM_JUDGE_CONTRACT_VERSION}\n${JSON.stringify(LLM_JUDGE_OUTPUT_SCHEMA)}`,
  );
  const host: CodexHostOptions = {
    codexCommand: options.codexCommand,
    model: options.model,
    repoRoot: options.repoRoot,
    cliEntry: options.cliEntry,
    profile: options.profile,
  };

  const results: EvalCaseResult[] = [];
  for (const [index, testCase] of options.cases.entries()) {
    process.stdout.write(
      `[${index + 1}/${options.cases.length}] ${testCase.id}: generating ${testCase.targetFormat.toUpperCase()}\n`,
    );
    const caseDirectory = path.join(directory, 'cases', testCase.id);
    await mkdir(caseDirectory, { recursive: true });
    const result = await runOneCase(host, options, testCase, caseDirectory);
    results.push(result);
    await writeFile(
      path.join(caseDirectory, 'case-result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    process.stdout.write(
      `[${index + 1}/${options.cases.length}] ${testCase.id}: ${result.score.toFixed(1)} (${result.passed ? 'pass' : 'fail'})\n`,
    );
    if (options.failFast && !result.passed) break;
  }

  const completedAt = new Date();
  const provenance: EvalRunProvenance = {
    schemaVersion: 1,
    runId,
    label: options.label,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    suite: options.suite,
    profile: options.profile,
    judgeMode: options.judgeMode,
    threshold: options.threshold,
    model: options.model,
    codexCommand: options.codexCommand,
    codexVersion,
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    gitCommit: git.commit,
    gitDirty: git.dirty,
    cliEntry: options.cliEntry,
    cliSha256,
    promptProfileSha256: profileSha256,
    judgeContractSha256,
  };
  const run: EvalRunResult = {
    provenance,
    score: average(results.map((result) => result.score)),
    passed: results.length === options.cases.length && results.every((result) => result.passed),
    cases: results,
  };
  await writeRunReport(directory, run);
  return { directory, run };
}

async function runOneCase(
  host: CodexHostOptions,
  options: RunEvalOptions,
  testCase: EvalCase,
  caseDirectory: string,
): Promise<EvalCaseResult> {
  const expectedArtifactPath = path.join(caseDirectory, testCase.artifactFilename);
  try {
    const generation = await runGeneration(host, testCase, caseDirectory);
    const traceMarkdown = generation.traceMarkdown;
    const markdown = traceMarkdown ?? generation.result.markdown;
    const traceMarkdownMatchesFinal = traceMarkdown
      ? normalizeMarkdown(traceMarkdown) === normalizeMarkdown(generation.result.markdown)
      : null;
    await writeFile(path.join(caseDirectory, 'authored.md'), markdown);
    const artifactJudge = await judgeArtifact(expectedArtifactPath, testCase);
    const markdownJudge = judgeMarkdown(markdown, testCase);
    await Promise.all([
      writeFile(
        path.join(caseDirectory, 'artifact-static-judge.json'),
        `${JSON.stringify(artifactJudge, null, 2)}\n`,
      ),
      writeFile(
        path.join(caseDirectory, 'markdown-static-judge.json'),
        `${JSON.stringify(markdownJudge, null, 2)}\n`,
      ),
    ]);

    let llmJudge: LlmJudgeResult | null = null;
    let llmScore: number | null = null;
    let judgeDurationMs: number | null = null;
    let judgeUsage = null;
    if (options.judgeMode === 'both') {
      process.stdout.write(`[judge] ${testCase.id}: evaluating authored Markdown\n`);
      const judged = await runLlmJudge(host, testCase, markdown, caseDirectory);
      llmJudge = judged.result;
      llmScore = scoreLlmJudge(llmJudge);
      judgeDurationMs = judged.process.durationMs;
      judgeUsage = judged.usage;
    }
    const score = combinedScore(artifactJudge.score, markdownJudge.score, llmScore);
    const passed =
      artifactJudge.passed &&
      markdownJudge.passed &&
      score >= options.threshold &&
      traceMarkdownMatchesFinal !== false;
    return {
      caseId: testCase.id,
      title: testCase.title,
      targetFormat: testCase.targetFormat,
      passed,
      score,
      artifactScore: artifactJudge.score,
      markdownScore: markdownJudge.score,
      llmScore,
      markdownSource: traceMarkdown ? 'trace' : 'final-response',
      traceMarkdownMatchesFinal,
      artifactPath: expectedArtifactPath,
      caseDirectory,
      generationDurationMs: generation.process.durationMs,
      judgeDurationMs,
      generationUsage: generation.usage,
      judgeUsage,
      mcpTraceMetrics: generation.traceMetrics,
      artifactJudge,
      markdownJudge,
      llmJudge,
      failure:
        traceMarkdownMatchesFinal === false
          ? 'Markdown in the final response does not match the Markdown captured from the final conversion tool call'
          : null,
    };
  } catch (caught: unknown) {
    const message = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught);
    const failedJudge = failureJudge(message);
    return {
      caseId: testCase.id,
      title: testCase.title,
      targetFormat: testCase.targetFormat,
      passed: false,
      score: 0,
      artifactScore: 0,
      markdownScore: 0,
      llmScore: null,
      markdownSource: 'final-response',
      traceMarkdownMatchesFinal: null,
      artifactPath: expectedArtifactPath,
      caseDirectory,
      generationDurationMs: 0,
      judgeDurationMs: null,
      generationUsage: null,
      judgeUsage: null,
      mcpTraceMetrics: null,
      artifactJudge: failedJudge,
      markdownJudge: failedJudge,
      llmJudge: null,
      failure: message,
    };
  }
}

export function combinedScore(
  artifactScore: number,
  markdownScore: number,
  llmScore: number | null,
): number {
  const components = [
    { score: artifactScore, weight: 0.35 },
    { score: markdownScore, weight: 0.25 },
    ...(llmScore === null ? [] : [{ score: llmScore, weight: 0.4 }]),
  ];
  const totalWeight = components.reduce((sum, component) => sum + component.weight, 0);
  return round(
    components.reduce((sum, component) => sum + component.score * component.weight, 0) /
      totalWeight,
  );
}

export function scoreLlmJudge(result: LlmJudgeResult): number {
  const scores = result.scores;
  const weighted =
    scores.briefAdherence +
    scores.contentQuality +
    scores.structure +
    scores.formatFitness +
    scores.squisqUsage +
    scores.overall * 2;
  const qualitativeScore = (weighted / 35) * 100;
  const groundingPenalty = Math.min(
    40,
    result.unsupportedClaims.length * 3 + result.missingRequestedElements.length * 5,
  );
  return round(Math.max(0, qualitativeScore - groundingPenalty));
}

async function getCodexVersion(command: string, cwd: string): Promise<string> {
  const resolved = await resolveCodexCommand(command);
  try {
    const capture = await runCapturedProcess({
      command: resolved.command,
      args: [...resolved.prefixArgs, '--version'],
      cwd,
      timeoutMs: 10_000,
    });
    return capture.exitCode === 0 ? capture.stdout.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function getGitProvenance(
  cwd: string,
): Promise<{ readonly commit: string | null; readonly dirty: boolean | null }> {
  try {
    const [commit, status] = await Promise.all([
      runCapturedProcess({
        command: 'git',
        args: ['rev-parse', 'HEAD'],
        cwd,
        timeoutMs: 10_000,
      }),
      runCapturedProcess({
        command: 'git',
        args: ['status', '--porcelain'],
        cwd,
        timeoutMs: 10_000,
      }),
    ]);
    return {
      commit: commit.exitCode === 0 ? commit.stdout.trim() : null,
      dirty: status.exitCode === 0 ? status.stdout.trim().length > 0 : null,
    };
  } catch {
    return { commit: null, dirty: null };
  }
}

function failureJudge(message: string): StaticJudgeResult {
  return summarizeChecks(
    [
      {
        id: 'harness-execution',
        passed: false,
        required: true,
        message,
        observed: false,
        expected: true,
      },
    ],
    {},
  );
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n/g, '\n').trim();
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function timestampId(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

function sanitizeLabel(label: string): string {
  const sanitized = label
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!sanitized) throw new Error('Eval label must contain at least one letter or number');
  return sanitized.slice(0, 64);
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
