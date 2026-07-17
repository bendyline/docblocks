import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EvalComparison, EvalRunMetrics, EvalRunResult } from './types.js';

export function compareEvalRuns(baseline: EvalRunResult, candidate: EvalRunResult): EvalComparison {
  assertPairedCases(baseline, candidate);
  if (baseline.provenance.judgeMode !== candidate.provenance.judgeMode) {
    throw new Error('Paired comparison requires the same judge mode');
  }
  const candidateById = new Map(candidate.cases.map((result) => [result.caseId, result]));
  const cases = baseline.cases.map((baselineCase) => {
    const candidateCase = candidateById.get(baselineCase.caseId);
    if (!candidateCase) {
      throw new Error(`Candidate run is missing baseline case ${baselineCase.caseId}`);
    }
    return {
      caseId: baselineCase.caseId,
      baselineScore: baselineCase.score,
      candidateScore: candidateCase.score,
      delta: round(candidateCase.score - baselineCase.score),
      baselinePassed: baselineCase.passed,
      candidatePassed: candidateCase.passed,
    };
  });
  const warnings = comparisonWarnings(baseline, candidate);
  return {
    baselineRunId: baseline.provenance.runId,
    candidateRunId: candidate.provenance.runId,
    baselineScore: baseline.score,
    candidateScore: candidate.score,
    delta: round(candidate.score - baseline.score),
    regressions: cases.filter(
      (result) => result.delta < 0 || (result.baselinePassed && !result.candidatePassed),
    ).length,
    improvements: cases.filter(
      (result) => result.delta > 0 || (!result.baselinePassed && result.candidatePassed),
    ).length,
    warnings,
    baselineMetrics: summarizeRunMetrics(baseline),
    candidateMetrics: summarizeRunMetrics(candidate),
    cases,
  };
}

export function summarizeRunMetrics(run: EvalRunResult): EvalRunMetrics {
  return run.cases.reduce<EvalRunMetrics>((metrics, result) => {
    const generation = result.generationUsage;
    const judge = result.judgeUsage;
    const trace = result.mcpTraceMetrics;
    return {
      generationDurationMs: metrics.generationDurationMs + result.generationDurationMs,
      judgeDurationMs: metrics.judgeDurationMs + (result.judgeDurationMs ?? 0),
      generationInputTokens: metrics.generationInputTokens + (generation?.inputTokens ?? 0),
      generationCachedInputTokens:
        metrics.generationCachedInputTokens + (generation?.cachedInputTokens ?? 0),
      generationUncachedInputTokens:
        metrics.generationUncachedInputTokens +
        Math.max(0, (generation?.inputTokens ?? 0) - (generation?.cachedInputTokens ?? 0)),
      generationOutputTokens: metrics.generationOutputTokens + (generation?.outputTokens ?? 0),
      generationReasoningTokens:
        metrics.generationReasoningTokens + (generation?.reasoningOutputTokens ?? 0),
      judgeInputTokens: metrics.judgeInputTokens + (judge?.inputTokens ?? 0),
      judgeOutputTokens: metrics.judgeOutputTokens + (judge?.outputTokens ?? 0),
      toolCallCount: metrics.toolCallCount + (trace?.toolCallCount ?? 0),
      toolArgumentCharacters: metrics.toolArgumentCharacters + (trace?.toolArgumentCharacters ?? 0),
      toolResultCharacters: metrics.toolResultCharacters + (trace?.toolResultCharacters ?? 0),
      authoringContextResultCharacters:
        metrics.authoringContextResultCharacters + (trace?.authoringContextResultCharacters ?? 0),
      authoringContextTextCharacters:
        metrics.authoringContextTextCharacters + (trace?.authoringContextTextCharacters ?? 0),
      authoringContextStructuredCharacters:
        metrics.authoringContextStructuredCharacters +
        (trace?.authoringContextStructuredCharacters ?? 0),
    };
  }, emptyRunMetrics());
}

export async function readEvalRun(runOrDirectory: string): Promise<EvalRunResult> {
  const file =
    path.extname(runOrDirectory) === '.json'
      ? runOrDirectory
      : path.join(runOrDirectory, 'run.json');
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!isRecord(parsed) || !isRecord(parsed.provenance) || !Array.isArray(parsed.cases)) {
    throw new Error(`${file} is not a DocBlocks MCP eval run`);
  }
  return parsed as unknown as EvalRunResult;
}

export async function writeRunReport(directory: string, run: EvalRunResult): Promise<void> {
  await Promise.all([
    writeFile(path.join(directory, 'run.json'), `${JSON.stringify(run, null, 2)}\n`),
    writeFile(path.join(directory, 'summary.md'), runMarkdown(run)),
  ]);
}

export async function writeComparisonReport(
  outputDirectory: string,
  comparison: EvalComparison,
): Promise<void> {
  await Promise.all([
    writeFile(
      path.join(outputDirectory, 'comparison.json'),
      `${JSON.stringify(comparison, null, 2)}\n`,
    ),
    writeFile(path.join(outputDirectory, 'comparison.md'), comparisonMarkdown(comparison)),
  ]);
}

function runMarkdown(run: EvalRunResult): string {
  const metrics = summarizeRunMetrics(run);
  const rows = run.cases.map(
    (result) =>
      `| ${result.caseId} | ${result.targetFormat} | ${result.score.toFixed(1)} | ${result.artifactScore.toFixed(1)} | ${result.markdownScore.toFixed(1)} | ${result.llmScore?.toFixed(1) ?? 'n/a'} | ${result.passed ? 'pass' : 'fail'} |`,
  );
  const failures = run.cases.flatMap((result) => {
    const failedChecks = [...result.artifactJudge.checks, ...result.markdownJudge.checks].filter(
      (check) => check.required && !check.passed,
    );
    return [
      ...(result.failure ? [`- **${result.caseId}:** ${result.failure}`] : []),
      ...failedChecks.map((check) => `- **${result.caseId} / ${check.id}:** ${check.message}`),
      ...(result.llmJudge?.weaknesses.map(
        (weakness) => `- **${result.caseId} / LLM:** ${weakness}`,
      ) ?? []),
      ...(result.llmJudge?.unsupportedClaims.map(
        (claim) => `- **${result.caseId} / unsupported claim:** ${claim}`,
      ) ?? []),
      ...(result.llmJudge?.missingRequestedElements.map(
        (element) => `- **${result.caseId} / missing element:** ${element}`,
      ) ?? []),
    ];
  });
  return `# DocBlocks MCP content eval: ${run.provenance.label}

- Run: \`${run.provenance.runId}\`
- Score: **${run.score.toFixed(1)}**
- Result: **${run.passed ? 'pass' : 'fail'}**
- Suite/profile: \`${run.provenance.suite}\` / \`${run.provenance.profile}\`
- Judge mode/model: \`${run.provenance.judgeMode}\` / \`${run.provenance.model ?? 'Codex default'}\`
- Git: \`${run.provenance.gitCommit ?? 'unknown'}\`${run.provenance.gitDirty ? ' (dirty)' : ''}
- CLI SHA-256: \`${run.provenance.cliSha256}\`
- Judge contract SHA-256: \`${run.provenance.judgeContractSha256}\`

## Efficiency

- Generation time: **${formatDuration(metrics.generationDurationMs)}**
- Generation input tokens: **${formatInteger(metrics.generationInputTokens)}** total / **${formatInteger(metrics.generationUncachedInputTokens)}** uncached
- Generation output tokens: **${formatInteger(metrics.generationOutputTokens)}**
- MCP calls/results: **${formatInteger(metrics.toolCallCount)}** / **${formatInteger(metrics.toolResultCharacters)} characters**
- Authoring-context result: **${formatInteger(metrics.authoringContextResultCharacters)} characters** (**${formatInteger(metrics.authoringContextTextCharacters)} text**, **${formatInteger(metrics.authoringContextStructuredCharacters)} structured**)

| Case | Format | Overall | OOXML | Markdown | LLM | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
${rows.join('\n')}

## Findings

${failures.length > 0 ? failures.join('\n') : '- No required static failures or LLM weaknesses were reported.'}
`;
}

function comparisonMarkdown(comparison: EvalComparison): string {
  const rows = comparison.cases.map(
    (result) =>
      `| ${result.caseId} | ${result.baselineScore.toFixed(1)} | ${result.candidateScore.toFixed(1)} | ${formatDelta(result.delta)} | ${result.baselinePassed ? 'pass' : 'fail'} → ${result.candidatePassed ? 'pass' : 'fail'} |`,
  );
  return `# DocBlocks MCP content eval comparison

- Baseline: \`${comparison.baselineRunId}\` — ${comparison.baselineScore.toFixed(1)}
- Candidate: \`${comparison.candidateRunId}\` — ${comparison.candidateScore.toFixed(1)}
- Aggregate delta: **${formatDelta(comparison.delta)}**
- Improved/regressed cases: **${comparison.improvements} / ${comparison.regressions}**

## Comparability

${comparison.warnings.length > 0 ? comparison.warnings.map((warning) => `- Warning: ${warning}`).join('\n') : '- Paired cases, judge mode, model, prompt profile, threshold, and Codex version match.'}

## Efficiency

| Metric | Baseline | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Generation time | ${formatDuration(comparison.baselineMetrics.generationDurationMs)} | ${formatDuration(comparison.candidateMetrics.generationDurationMs)} | ${formatSignedDuration(comparison.candidateMetrics.generationDurationMs - comparison.baselineMetrics.generationDurationMs)} |
| Input tokens | ${formatInteger(comparison.baselineMetrics.generationInputTokens)} | ${formatInteger(comparison.candidateMetrics.generationInputTokens)} | ${formatSignedInteger(comparison.candidateMetrics.generationInputTokens - comparison.baselineMetrics.generationInputTokens)} |
| Uncached input tokens | ${formatInteger(comparison.baselineMetrics.generationUncachedInputTokens)} | ${formatInteger(comparison.candidateMetrics.generationUncachedInputTokens)} | ${formatSignedInteger(comparison.candidateMetrics.generationUncachedInputTokens - comparison.baselineMetrics.generationUncachedInputTokens)} |
| Output tokens | ${formatInteger(comparison.baselineMetrics.generationOutputTokens)} | ${formatInteger(comparison.candidateMetrics.generationOutputTokens)} | ${formatSignedInteger(comparison.candidateMetrics.generationOutputTokens - comparison.baselineMetrics.generationOutputTokens)} |
| MCP result characters | ${formatInteger(comparison.baselineMetrics.toolResultCharacters)} | ${formatInteger(comparison.candidateMetrics.toolResultCharacters)} | ${formatSignedInteger(comparison.candidateMetrics.toolResultCharacters - comparison.baselineMetrics.toolResultCharacters)} |
| Authoring-context characters | ${formatInteger(comparison.baselineMetrics.authoringContextResultCharacters)} | ${formatInteger(comparison.candidateMetrics.authoringContextResultCharacters)} | ${formatSignedInteger(comparison.candidateMetrics.authoringContextResultCharacters - comparison.baselineMetrics.authoringContextResultCharacters)} |

| Case | Baseline | Candidate | Delta | Result |
| --- | ---: | ---: | ---: | --- |
${rows.join('\n')}
`;
}

function formatDelta(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}

function assertPairedCases(baseline: EvalRunResult, candidate: EvalRunResult): void {
  const baselineIds = baseline.cases.map(({ caseId }) => caseId).sort();
  const candidateIds = candidate.cases.map(({ caseId }) => caseId).sort();
  if (JSON.stringify(baselineIds) !== JSON.stringify(candidateIds)) {
    throw new Error('Paired comparison requires exactly the same case ids');
  }
  const candidateById = new Map(candidate.cases.map((result) => [result.caseId, result]));
  for (const baselineCase of baseline.cases) {
    if (candidateById.get(baselineCase.caseId)?.targetFormat !== baselineCase.targetFormat) {
      throw new Error(`Paired case ${baselineCase.caseId} changed target format`);
    }
  }
}

function comparisonWarnings(baseline: EvalRunResult, candidate: EvalRunResult): string[] {
  const warnings: string[] = [];
  const pairs: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ['prompt profile', baseline.provenance.profile, candidate.provenance.profile],
    [
      'prompt-profile hash',
      baseline.provenance.promptProfileSha256,
      candidate.provenance.promptProfileSha256,
    ],
    [
      'judge-contract hash',
      baseline.provenance.judgeContractSha256,
      candidate.provenance.judgeContractSha256,
    ],
    ['model', baseline.provenance.model, candidate.provenance.model],
    ['threshold', baseline.provenance.threshold, candidate.provenance.threshold],
    ['Codex version', baseline.provenance.codexVersion, candidate.provenance.codexVersion],
  ];
  for (const [label, baselineValue, candidateValue] of pairs) {
    if (baselineValue !== candidateValue) {
      warnings.push(
        `${label} differs: ${JSON.stringify(baselineValue)} versus ${JSON.stringify(candidateValue)}`,
      );
    }
  }
  if (baseline.provenance.model === null && candidate.provenance.model === null) {
    warnings.push(
      'both runs use the mutable Codex default model; pin --model for launch decisions',
    );
  }
  return warnings;
}

function emptyRunMetrics(): EvalRunMetrics {
  return {
    generationDurationMs: 0,
    judgeDurationMs: 0,
    generationInputTokens: 0,
    generationCachedInputTokens: 0,
    generationUncachedInputTokens: 0,
    generationOutputTokens: 0,
    generationReasoningTokens: 0,
    judgeInputTokens: 0,
    judgeOutputTokens: 0,
    toolCallCount: 0,
    toolArgumentCharacters: 0,
    toolResultCharacters: 0,
    authoringContextResultCharacters: 0,
    authoringContextTextCharacters: 0,
    authoringContextStructuredCharacters: 0,
  };
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatSignedInteger(value: number): string {
  return `${value >= 0 ? '+' : ''}${formatInteger(value)}`;
}

function formatDuration(value: number): string {
  return `${(value / 1_000).toFixed(1)}s`;
}

function formatSignedDuration(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value / 1_000).toFixed(1)}s`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
