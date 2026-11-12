/**
 * Run the pack's cases against one model and write one outcome per case.
 * Loaded only after a DOM is registered (see dom.ts): the pipelines import
 * Squisq's editor package.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BENCH_PACK_SCHEMA_VERSION, type BenchCaseOutcome, type BenchEvent } from './contract.js';
import { endpointChat, type EndpointOptions, type RecordedCall } from './endpoint.js';
import { DOCBENCH_TASKS, DOCBENCH_VERSION } from './pack.js';
import type { BenchTask, TaskCaseResult } from './tasks/types.js';

export interface RunOptions {
  readonly endpoint: Omit<EndpointOptions, 'seed'>;
  readonly seed: number | null;
  readonly trial: number;
  readonly now: Date;
  /** Task ids to run; all when empty. */
  readonly tasks: readonly string[];
  /** Case ids to run; all when empty. */
  readonly cases: readonly string[];
  readonly outDir: string;
  readonly emit: (event: BenchEvent) => void;
}

function outcomeFile(outDir: string, taskId: string, caseId: string, trial: number): string {
  return path.join(outDir, taskId, `${caseId}-t${String(trial)}.json`);
}

function selectedTasks(ids: readonly string[]): readonly BenchTask[] {
  if (ids.length === 0) return DOCBENCH_TASKS;
  const unknown = ids.filter((id) => !DOCBENCH_TASKS.some((task) => task.info.id === id));
  if (unknown.length > 0) throw new Error(`Unknown task: ${unknown.join(', ')}`);
  return DOCBENCH_TASKS.filter((task) => ids.includes(task.info.id));
}

/** The outcome of one case, with the transport's view of every call it made. */
export async function runCase(
  task: BenchTask,
  caseId: string,
  options: Pick<RunOptions, 'endpoint' | 'seed' | 'trial' | 'now'>,
): Promise<BenchCaseOutcome> {
  const testCase = task.cases().find((item) => item.id === caseId);
  if (!testCase) throw new Error(`Task ${task.info.id} has no case ${caseId}.`);
  const calls: RecordedCall[] = [];
  const ai = endpointChat(
    { ...options.endpoint, ...(options.seed === null ? {} : { seed: options.seed }) },
    calls,
  );
  const started = Date.now();
  let result: TaskCaseResult | null = null;
  let thrown: string | null = null;
  try {
    result = await task.run(testCase, {
      ai,
      contextWindow: options.endpoint.contextWindow,
      now: options.now,
    });
  } catch (error: unknown) {
    thrown = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
  const infra = calls.find((call) => call.infra);
  // An endpoint failure says nothing about the model, whatever the pipeline made of it.
  const error: BenchCaseOutcome['error'] = infra
    ? { class: 'infra', message: infra.error ?? 'The endpoint failed.' }
    : thrown
      ? // A crash in the pack is ours, not the model's: report it as infrastructure.
        { class: 'infra', message: thrown }
      : result && !result.usable
        ? { class: 'model', message: result.modelError ?? 'The output was not usable.' }
        : null;
  return {
    schemaVersion: BENCH_PACK_SCHEMA_VERSION,
    packVersion: DOCBENCH_VERSION,
    taskId: task.info.id,
    caseId,
    trial: options.trial,
    seed: options.seed,
    model: options.endpoint.model,
    contextWindow: options.endpoint.contextWindow,
    usable: !infra && !thrown && (result?.usable ?? false),
    checks: result?.checks ?? [],
    artifact: result?.artifact ?? null,
    judgeInput: infra || thrown ? null : (result?.judgeInput ?? null),
    calls: calls.map((call) => ({
      promptTokens: call.promptTokens,
      completionTokens: call.completionTokens,
      finishReason: call.finishReason,
      ms: call.ms,
      ...(call.engineMaxTokens === undefined ? {} : { engineMaxTokens: call.engineMaxTokens }),
    })),
    error,
    // Why Gezel ended a reply early (the ramble guard, a grammar the engine
    // rejected), which the pipeline only sees as a failed request.
    notes: [
      ...(result?.notes ?? []),
      ...calls.flatMap((call) =>
        !call.infra && call.error ? [`Gezel ended a reply: ${call.error}`] : [],
      ),
    ],
    ms: Date.now() - started,
  };
}

export async function runPack(options: RunOptions): Promise<number> {
  const tasks = selectedTasks(options.tasks);
  const work = tasks.flatMap((task) =>
    task
      .cases()
      .filter((item) => options.cases.length === 0 || options.cases.includes(item.id))
      .map((item) => ({ task, caseId: item.id })),
  );
  const started = Date.now();
  options.emit({
    type: 'start',
    model: options.endpoint.model,
    contextWindow: options.endpoint.contextWindow,
    cases: work.length,
  });
  for (const { task, caseId } of work) {
    options.emit({ type: 'case-start', taskId: task.info.id, caseId });
    const outcome = await runCase(task, caseId, options);
    const file = outcomeFile(options.outDir, task.info.id, caseId, options.trial);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(outcome, null, 2)}\n`);
    options.emit({
      type: 'case-done',
      taskId: task.info.id,
      caseId,
      usable: outcome.usable,
      error: outcome.error?.class ?? null,
      ms: outcome.ms,
      file,
    });
  }
  options.emit({ type: 'done', cases: work.length, ms: Date.now() - started });
  return work.length;
}
