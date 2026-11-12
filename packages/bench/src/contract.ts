/**
 * The docbench task-pack contract: what `docbench-pack describe` prints and
 * what `docbench-pack run` writes for each case.
 *
 * A benchmark harness (Gezel's `eval:docbench`) owns models, scheduling,
 * judging and scoring; this pack owns what is tested. They meet only through
 * these JSON shapes over a process boundary, so neither imports the other.
 * Gezel validates every document against its own Zod copy of this contract
 * (`@bendyline/gezel/eval`, `bench-pack.ts`): change both together and bump
 * {@link BENCH_PACK_SCHEMA_VERSION} on any breaking change.
 */

export const BENCH_PACK_SCHEMA_VERSION = 1;

/** One family of workloads; the docbench score is a weighted mean of family scores. */
export interface BenchFamily {
  readonly id: string;
  readonly label: string;
  /** Share of the docbench score, 0–1; the declared families sum to 1. */
  readonly weight: number;
}

export interface BenchJudgeAxis {
  readonly id: string;
  readonly label: string;
  /** What a judge looks for, written for the judge. */
  readonly description: string;
}

/**
 * How a case's output is judged.
 *
 * - `rubric`: the judge scores each axis 0–10 from the artifact and context.
 * - `matcher`: the judge matches the output's items against an answer key
 *   (found or missed per key issue; valid, trivial or wrong per item), and the
 *   harness computes recall, precision and F1 from those labels. Axes, when
 *   given, are scored 0–10 alongside.
 */
export interface BenchJudgeSpec {
  /** Versioned, such as `review-matcher@1`: a change to the rubric's text bumps it. */
  readonly rubricId: string;
  readonly mode: 'rubric' | 'matcher';
  readonly axes: readonly BenchJudgeAxis[];
  /** The artifact is a picture: show the judge a rendering, not only the source. */
  readonly vision?: boolean;
  /** For `matcher`: how much of the judge score the F1 carries; axes share the rest. */
  readonly matchWeight?: number;
  /**
   * For `matcher`: also label each output item's complexity
   * ({@link BenchComplexity}), so a report can count low, medium and high
   * suggestions. Recall then weights answer-key issues by their `level`.
   */
  readonly levels?: boolean;
  /** Written for the judge: what the task asked the model to do. */
  readonly instructions: string;
}

/**
 * How much a fix takes. `low`: mechanical (a typo, punctuation, a number's
 * format, one wrong word). `medium`: rewording a sentence (wordiness, passive
 * voice, jargon, an overstated claim). `high`: paragraph or document level (a
 * buried main point, a contradiction between sections, a missing definition,
 * structure).
 */
export type BenchComplexity = 'low' | 'medium' | 'high';

export interface BenchCaseInfo {
  readonly id: string;
  readonly label: string;
}

export interface BenchTaskInfo {
  readonly id: string;
  readonly family: string;
  readonly label: string;
  /** What the task exercises in the product, for reports. */
  readonly description: string;
  /**
   * Independent samples per case. Tasks the product runs at a low temperature
   * are nearly deterministic, so one is enough; warmer tasks get more.
   */
  readonly trials: number;
  /** How a case's score splits between deterministic checks and the judge; sums to 1. */
  readonly scoring: { readonly checks: number; readonly judge: number };
  /** The task's weight within its family; 1 when absent. */
  readonly weight?: number;
  readonly judge: BenchJudgeSpec | null;
  readonly cases: readonly BenchCaseInfo[];
}

/** `docbench-pack describe --json`. */
export interface BenchPackManifest {
  readonly schemaVersion: typeof BENCH_PACK_SCHEMA_VERSION;
  readonly id: string;
  /** The benchmark version: fixtures, prompts' expectations, rubrics and weights. */
  readonly version: string;
  /**
   * The fixture set the cases come from: `public` (this package's) or a
   * swapped-in set such as a private holdout, with a hash of its content.
   */
  readonly fixtures?: { readonly id: string; readonly sha256: string };
  readonly families: readonly BenchFamily[];
  readonly tasks: readonly BenchTaskInfo[];
}

/** One deterministic check, scored 0–1 (a pass/fail check is 0 or 1). */
export interface BenchCheck {
  readonly id: string;
  readonly label: string;
  readonly score: number;
  readonly weight: number;
  readonly detail?: string;
}

export interface BenchArtifact {
  readonly kind: 'markdown' | 'json' | 'svg' | 'text';
  readonly content: string;
}

/** An answer-key entry a matcher judge looks for. */
export interface BenchAnswerKeyItem {
  readonly id: string;
  /** Where the issue is, quoted from the source. */
  readonly quote?: string;
  readonly issue: string;
  /** How much fixing it takes; finding a harder issue counts for more. */
  readonly level?: BenchComplexity;
}

/** One item of the model's output a matcher judge labels. */
export interface BenchOutputItem {
  readonly id: string;
  readonly text: string;
}

export interface BenchJudgeInput {
  readonly rubricId: string;
  /** What the model was given: the document, passage or brief. */
  readonly context: string;
  readonly answerKey?: readonly BenchAnswerKeyItem[];
  readonly items?: readonly BenchOutputItem[];
  /** A reference answer the judge may compare against. */
  readonly reference?: string;
}

/** One model request the case made. */
export interface BenchCall {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly finishReason: 'stop' | 'length' | 'cancelled' | 'error';
  readonly ms: number;
  /** The engine lowered the request's output cap (Gezel's `gezel_max_tokens`). */
  readonly engineMaxTokens?: number;
}

/** `docbench-pack run` writes one of these per case, to `<out-dir>/<task>/<case>-t<trial>.json`. */
export interface BenchCaseOutcome {
  readonly schemaVersion: typeof BENCH_PACK_SCHEMA_VERSION;
  readonly packVersion: string;
  readonly taskId: string;
  readonly caseId: string;
  readonly trial: number;
  readonly seed: number | null;
  readonly model: string;
  /** The context window the product's budgets were sized for, or null when unknown. */
  readonly contextWindow: number | null;
  /** The product would have shown the person something from the model. */
  readonly usable: boolean;
  readonly checks: readonly BenchCheck[];
  readonly artifact: BenchArtifact | null;
  readonly judgeInput: BenchJudgeInput | null;
  readonly calls: readonly BenchCall[];
  /**
   * Why the case did not complete. `infra`: the endpoint failed (connection,
   * HTTP error, timeout) and the case says nothing about the model, so a
   * harness retries or excludes it. `model`: the model's output broke the
   * pipeline.
   */
  readonly error: { readonly class: 'model' | 'infra'; readonly message: string } | null;
  /** What the pipeline said along the way, for people reading a report. */
  readonly notes: readonly string[];
  readonly ms: number;
}

/** Progress lines on stdout: `[bench-event] {json}`. */
export type BenchEvent =
  | {
      readonly type: 'start';
      readonly model: string;
      readonly contextWindow: number | null;
      readonly cases: number;
    }
  | { readonly type: 'case-start'; readonly taskId: string; readonly caseId: string }
  | {
      readonly type: 'case-done';
      readonly taskId: string;
      readonly caseId: string;
      readonly usable: boolean;
      readonly error: 'model' | 'infra' | null;
      readonly ms: number;
      readonly file: string;
    }
  | { readonly type: 'done'; readonly cases: number; readonly ms: number };

export const BENCH_EVENT_PREFIX = '[bench-event] ';
