import path from 'node:path';
import { Command } from 'commander';
import { EVAL_PROMPT_PROFILES, MCP_CONTENT_EVAL_CASES, selectEvalCases } from './cases.js';
import { compareEvalRuns, readEvalRun, writeComparisonReport } from './report.js';
import { runEval } from './runner.js';
import type { EvalJudgeMode, EvalPromptProfile } from './types.js';

const program = new Command()
  .name('docblocks-mcp-eval')
  .description(
    'Run reproducible Codex content evaluations against the locally built DocBlocks MCP',
  );

program
  .command('list')
  .description('List canonical content evaluation cases')
  .action(() => {
    for (const testCase of MCP_CONTENT_EVAL_CASES) {
      process.stdout.write(
        `${testCase.id}\t${testCase.targetFormat}\t${testCase.suites.join(',')}\t${testCase.title}\n`,
      );
    }
  });

program
  .command('run')
  .description('Build one isolated eval run and preserve traces, artifacts, judges, and provenance')
  .option('--suite <suite-or-ids>', 'quick, full, or comma-separated case ids', 'quick')
  .option('--label <label>', 'run label', 'baseline')
  .option('--profile <profile>', 'baseline or content-first', 'baseline')
  .option('--judge <mode>', 'static or both', 'both')
  .option('--threshold <score>', 'passing score from 0 through 100', '70')
  .option('--model <model>', 'pin a Codex model; defaults to the Codex CLI default')
  .option(
    '--codex-command <command>',
    'Codex executable',
    process.platform === 'win32' ? 'codex.cmd' : 'codex',
  )
  .option('--repo-root <directory>', 'DocBlocks checkout', process.cwd())
  .option('--cli-entry <file>', 'built DocBlocks CLI entry')
  .option('--reports-dir <directory>', 'eval report root')
  .option('--fail-fast', 'stop after the first failing case', false)
  .option('--enforce', 'exit nonzero when the run misses its threshold', false)
  .action(async (raw: RunCommandOptions) => {
    const repoRoot = path.resolve(raw.repoRoot);
    const profile = requireProfile(raw.profile);
    const judgeMode = requireJudgeMode(raw.judge);
    const threshold = requireThreshold(raw.threshold);
    const cliEntry = path.resolve(
      raw.cliEntry ?? path.join(repoRoot, 'packages', 'cli', 'dist', 'bin.js'),
    );
    const reportsDirectory = path.resolve(
      raw.reportsDir ?? path.join(repoRoot, 'reports', 'mcp-content-evals'),
    );
    const result = await runEval({
      label: raw.label,
      suite: raw.suite,
      cases: selectEvalCases(raw.suite),
      profile,
      judgeMode,
      threshold,
      model: raw.model ?? null,
      codexCommand: raw.codexCommand,
      repoRoot,
      cliEntry,
      reportsDirectory,
      failFast: raw.failFast,
    });
    process.stdout.write(`Run report: ${result.directory}\n`);
    process.stdout.write(
      `Aggregate score: ${result.run.score.toFixed(1)} (${result.run.passed ? 'pass' : 'fail'})\n`,
    );
    if (raw.enforce && !result.run.passed) process.exitCode = 1;
  });

program
  .command('compare')
  .description('Compare paired cases from a baseline and candidate run')
  .argument('<baseline>', 'baseline run directory or run.json')
  .argument('<candidate>', 'candidate run directory or run.json')
  .option('--output <directory>', 'comparison output directory')
  .option(
    '--enforce-no-regression',
    'exit nonzero when any paired case regresses or changes from pass to fail',
    false,
  )
  .action(async (baselinePath: string, candidatePath: string, raw: CompareCommandOptions) => {
    const [baseline, candidate] = await Promise.all([
      readEvalRun(path.resolve(baselinePath)),
      readEvalRun(path.resolve(candidatePath)),
    ]);
    const comparison = compareEvalRuns(baseline, candidate);
    const output = path.resolve(
      raw.output ??
        path.join(
          path.extname(candidatePath) === '.json' ? path.dirname(candidatePath) : candidatePath,
          `comparison-vs-${baseline.provenance.runId}`,
        ),
    );
    await import('node:fs/promises').then(({ mkdir }) => mkdir(output, { recursive: true }));
    await writeComparisonReport(output, comparison);
    process.stdout.write(`Comparison report: ${output}\n`);
    process.stdout.write(
      `Aggregate delta: ${comparison.delta >= 0 ? '+' : ''}${comparison.delta.toFixed(1)}\n`,
    );
    process.stdout.write(`Case regressions: ${comparison.regressions}\n`);
    if (raw.enforceNoRegression && comparison.regressions > 0) process.exitCode = 1;
  });

interface RunCommandOptions {
  readonly suite: string;
  readonly label: string;
  readonly profile: string;
  readonly judge: string;
  readonly threshold: string;
  readonly model?: string;
  readonly codexCommand: string;
  readonly repoRoot: string;
  readonly cliEntry?: string;
  readonly reportsDir?: string;
  readonly failFast: boolean;
  readonly enforce: boolean;
}

interface CompareCommandOptions {
  readonly output?: string;
  readonly enforceNoRegression: boolean;
}

function requireProfile(value: string): EvalPromptProfile {
  if (value in EVAL_PROMPT_PROFILES) return value as EvalPromptProfile;
  throw new Error(`Unknown prompt profile ${JSON.stringify(value)}`);
}

function requireJudgeMode(value: string): EvalJudgeMode {
  if (value === 'static' || value === 'both') return value;
  throw new Error(`Judge mode must be static or both; received ${JSON.stringify(value)}`);
}

function requireThreshold(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`Threshold must be between 0 and 100; received ${JSON.stringify(value)}`);
  }
  return parsed;
}

void program.parseAsync().catch((caught: unknown) => {
  const message = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
