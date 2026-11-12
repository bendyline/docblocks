#!/usr/bin/env node
/**
 * docbench-pack: the DocBlocks task pack's command line.
 *
 *   docbench-pack describe
 *     Print the pack manifest (families, tasks, cases, rubrics) as JSON.
 *
 *   docbench-pack run --endpoint <baseUrl> --model <id> --out-dir <dir>
 *       [--trial <n>] [--seed <n>] [--now <iso>] [--context <tokens>]
 *       [--tasks a,b] [--cases x,y] [--request-timeout-ms <ms>]
 *     Run cases against one model; write one outcome JSON per case to
 *     <dir>/<task>/<case>-t<trial>.json and progress as `[bench-event] {…}`
 *     lines on stdout. This is what a harness (Gezel's eval:docbench) calls.
 *
 *   docbench-pack local --endpoint <baseUrl> --models a,b [--label <name>]
 *       [--context <tokens>] [--tasks a,b] [--out <dir>]
 *     The dev loop: every trial each task asks for, then a summary of the
 *     deterministic checks. No judge, so not a docbench score.
 *
 * The endpoint is any OpenAI-compatible `/v1` base URL. A bearer token, when
 * the endpoint needs one, comes from DOCBENCH_ENDPOINT_TOKEN, never argv.
 * The context window is read from the endpoint's `/v1/models` unless
 * `--context` overrides it.
 */

// First: captures Node's fetch before a DOM replaces it.
import { NodeAbortController, nodeFetch, registerDom } from './dom.js';
import path from 'node:path';
import { BENCH_EVENT_PREFIX, type BenchCaseOutcome, type BenchEvent } from './contract.js';

class UsageError extends Error {}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--'))
    throw new UsageError(`--${name} needs a value.`);
  return value;
}

function required(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new UsageError(`--${name} is required.`);
  return value;
}

function integer(args: readonly string[], name: string, fallback: number | null): number | null {
  const value = option(args, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`--${name} must be a whole number.`);
  }
  return parsed;
}

function list(args: readonly string[], name: string): string[] {
  return (option(args, name) ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function err(text: string): void {
  process.stderr.write(`${text}\n`);
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;

async function endpointFor(args: readonly string[], model: string) {
  const { endpointContextWindow } = await import('./endpoint.js');
  const baseUrl = required(args, 'endpoint');
  const token = process.env.DOCBENCH_ENDPOINT_TOKEN?.trim() || undefined;
  const override = integer(args, 'context', null);
  const contextWindow =
    override ??
    (await endpointContextWindow({
      baseUrl,
      model,
      ...(token ? { token } : {}),
      fetch: nodeFetch,
    }));
  return {
    baseUrl,
    model,
    ...(token ? { token } : {}),
    contextWindow,
    requestTimeoutMs:
      integer(args, 'request-timeout-ms', DEFAULT_REQUEST_TIMEOUT_MS) ?? DEFAULT_REQUEST_TIMEOUT_MS,
    fetch: nodeFetch,
    AbortController: NodeAbortController,
  };
}

function nowFrom(args: readonly string[]): Date {
  const value = option(args, 'now');
  if (!value) return new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new UsageError('--now must be an ISO date.');
  return date;
}

async function describe(): Promise<void> {
  const { describePack } = await import('./pack.js');
  out(JSON.stringify(describePack(), null, 2));
}

async function run(args: readonly string[]): Promise<void> {
  const { runPack } = await import('./run.js');
  const model = required(args, 'model');
  const endpoint = await endpointFor(args, model);
  await runPack({
    endpoint,
    seed: integer(args, 'seed', null),
    trial: integer(args, 'trial', 0) ?? 0,
    now: nowFrom(args),
    tasks: list(args, 'tasks'),
    cases: list(args, 'cases'),
    outDir: path.resolve(required(args, 'out-dir')),
    emit: (event: BenchEvent) => out(`${BENCH_EVENT_PREFIX}${JSON.stringify(event)}`),
  });
}

function percent(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}

/** Weighted check score of one outcome, 0–1. */
function checkScore(outcome: BenchCaseOutcome): number {
  if (!outcome.usable) return 0;
  const weight = outcome.checks.reduce((sum, item) => sum + item.weight, 0);
  return weight === 0
    ? 1
    : outcome.checks.reduce((sum, item) => sum + item.score * item.weight, 0) / weight;
}

async function local(args: readonly string[]): Promise<void> {
  const { runCase } = await import('./run.js');
  const { DOCBENCH_TASKS } = await import('./pack.js');
  const fs = await import('node:fs');
  const models = list(args, 'models');
  if (models.length === 0) throw new UsageError('--models is required.');
  const only = list(args, 'tasks');
  const tasks = DOCBENCH_TASKS.filter((task) => only.length === 0 || only.includes(task.info.id));
  const label = option(args, 'label') ?? `run-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
  const root = path.resolve(option(args, 'out') ?? path.join('reports', 'docbench', label));
  const now = nowFrom(args);
  const summary: string[] = [
    `# docbench (checks only): ${label}`,
    '',
    'Deterministic checks, no judge: not a docbench score.',
    '',
  ];
  for (const model of models) {
    const endpoint = await endpointFor(args, model);
    summary.push(
      `## ${model}`,
      '',
      `Context window: ${String(endpoint.contextWindow ?? 'unknown')}`,
      '',
      '| Task | Usable | Checks | Infra errors |',
      '| --- | --- | --- | --- |',
    );
    for (const task of tasks) {
      const outcomes: BenchCaseOutcome[] = [];
      for (let trial = 0; trial < task.info.trials; trial += 1) {
        for (const testCase of task.cases()) {
          const outcome = await runCase(task, testCase.id, {
            endpoint,
            seed: 1000 + trial,
            trial,
            now,
          });
          outcomes.push(outcome);
          const file = path.join(
            root,
            model.replace(/[^\w.-]+/gu, '_'),
            task.info.id,
            `${testCase.id}-t${String(trial)}.json`,
          );
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, `${JSON.stringify(outcome, null, 2)}\n`);
          err(
            `${model} ${task.info.id} ${testCase.id} t${String(trial)}: ` +
              `${outcome.usable ? 'usable' : `not usable (${outcome.error?.message.split('\n')[0] ?? ''})`} ` +
              `checks=${percent(checkScore(outcome))} ${String(Math.round(outcome.ms / 100) / 10)}s`,
          );
        }
      }
      const scored = outcomes.filter((outcome) => outcome.error?.class !== 'infra');
      const usable = scored.filter((outcome) => outcome.usable).length;
      const mean =
        scored.reduce((sum, outcome) => sum + checkScore(outcome), 0) / Math.max(1, scored.length);
      summary.push(
        `| ${task.info.label} | ${String(usable)}/${String(scored.length)} | ${percent(mean)} | ` +
          `${String(outcomes.length - scored.length)} |`,
      );
    }
    summary.push('');
  }
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'summary.md'), `${summary.join('\n')}\n`);
  out(summary.join('\n'));
  err(`Wrote ${root}`);
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  registerDom();
  try {
    if (command === 'describe') await describe();
    else if (command === 'run') await run(args);
    else if (command === 'local') await local(args);
    else throw new UsageError('Usage: docbench-pack <describe|run|local> [options]');
    return 0;
  } catch (error: unknown) {
    if (error instanceof UsageError) {
      err(error.message);
      return 2;
    }
    err(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
