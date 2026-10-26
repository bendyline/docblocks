/**
 * Run the model calls that turn a document into pictures, in two phases:
 * {@link findIdeas} picks passages and says what each picture should show,
 * and {@link drawIdea} draws one idea. The Illustrate panel lets the person
 * edit and add ideas between the two.
 *
 * Calls run strictly one at a time, each awaiting the previous call's `done`:
 * a local model serves one request at a time anyway, and the mobile host
 * refuses a second operation until the first has fully released its lock —
 * which it does only after delivering `done`, so starting the next call from
 * inside an event callback would be refused.
 */

import type {
  AiChatEvent,
  AiChatRequest,
  AiError,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';
import { extractPlainText, parseMarkdown } from '@bendyline/squisq/markdown';
import { compileDiagram, type CompiledDiagram } from './diagram-compile.js';
import { checkGrounding } from './diagram-grounding.js';
import {
  parseDiagramSpec,
  parseLooseNumber,
  type ChartSpec,
  type DiagramKind,
  type DiagramSpec,
} from './diagram-spec.js';
import { validateCompiledDiagram, type MermaidValidator } from './diagram-validate.js';
import { segmentPassages, shortlistPassages, type Passage } from './illustrate-passages.js';
import {
  buildPlanRequest,
  buildRealizeRequest,
  buildRepairRequest,
  parsePlanResponse,
  type PlanPick,
  type PromptBudget,
} from './illustrate-prompts.js';

type ChatApi = Pick<DocBlocksHostAiAPI, 'chat'>;

export type ChatOutcome =
  | { readonly kind: 'ok'; readonly text: string; readonly truncated: boolean }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error'; readonly error: AiError };

/**
 * Run one chat to completion; aborting `signal` cancels it. `onEvent` sees the
 * call's progress and deltas, for a status line; the reply comes from `done`.
 */
export async function chatOnce(
  ai: ChatApi,
  request: AiChatRequest,
  signal?: AbortSignal,
  onEvent?: (event: AiChatEvent) => void,
): Promise<ChatOutcome> {
  if (signal?.aborted) return { kind: 'cancelled' };
  const handle = ai.chat(request, onEvent ?? (() => undefined));
  const abort = () => handle.cancel();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await handle.done;
    if (signal?.aborted) return { kind: 'cancelled' };
    if (!result.ok) {
      return result.error.code === 'cancelled'
        ? { kind: 'cancelled' }
        : { kind: 'error', error: result.error };
    }
    if (result.value.finishReason === 'cancelled') return { kind: 'cancelled' };
    return {
      kind: 'ok',
      text: result.value.text,
      truncated: result.value.finishReason === 'length',
    };
  } catch (error: unknown) {
    return {
      kind: 'error',
      error: { code: 'unknown', message: error instanceof Error ? error.message : String(error) },
    };
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

export type DiagramOutcome =
  | {
      readonly status: 'ready';
      readonly spec: DiagramSpec;
      readonly compiled: CompiledDiagram;
      /** Trims and fixes applied while reading the model's reply. */
      readonly notes: readonly string[];
    }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'cancelled' };

export interface RealizeOptions {
  readonly ai: ChatApi;
  readonly kind: DiagramKind;
  /** The text to draw from: a passage, or the person's selection. */
  readonly material: string;
  readonly heading: string;
  readonly title: string;
  readonly description?: string;
  /** The description is the person's own words, so its facts count as stated too. */
  readonly descriptionFacts?: boolean;
  readonly avoid?: string;
  /**
   * Check the spec's facts against `material`. Off only when the person
   * asked for a diagram with no source text to stick to.
   */
  readonly ground: boolean;
  readonly budget: PromptBudget;
  readonly validateMermaid: MermaidValidator;
  readonly signal?: AbortSignal;
}

/** Ask for, check, and compile one diagram, repairing at most once. */
export async function realizeDiagram(options: RealizeOptions): Promise<DiagramOutcome> {
  let request = buildRealizeRequest({
    kind: options.kind,
    material: options.material,
    heading: options.heading,
    title: options.title,
    description: options.description,
    descriptionFacts: options.descriptionFacts,
    avoid: options.avoid,
    maxTokens: options.budget.realizeTokens,
  });
  const facts =
    options.descriptionFacts && options.description
      ? `${options.material}\n${options.description}`
      : options.material;
  let repaired = false;
  let widened = false;
  for (;;) {
    const outcome = await chatOnce(options.ai, request, options.signal);
    if (outcome.kind === 'cancelled') return { status: 'cancelled' };
    if (outcome.kind === 'error') return { status: 'failed', message: outcome.error.message };

    const parsed = parseDiagramSpec(options.kind, outcome.text);
    if (!parsed.ok) {
      // A reply cut off mid-JSON gets one retry with more room, then a repair.
      if (outcome.truncated && !widened) {
        widened = true;
        request = {
          ...request,
          maxTokens: Math.min(
            (request.maxTokens ?? options.budget.realizeTokens) * 2,
            Math.floor(options.budget.contextTokens / 2),
          ),
        };
        continue;
      }
      if (!repaired) {
        repaired = true;
        request = buildRepairRequest(request, outcome.text, parsed.problem);
        continue;
      }
      return {
        status: 'failed',
        message: `The model's diagram could not be used. ${parsed.problem}`,
      };
    }

    if (options.ground) {
      const grounding = checkGrounding(parsed.spec, facts);
      if (!grounding.ok) {
        if (!repaired) {
          repaired = true;
          request = buildRepairRequest(request, outcome.text, grounding.problems.join(' '));
          continue;
        }
        return {
          status: 'failed',
          message: `The diagram used facts that are not in the text. ${grounding.problems.join(' ')}`,
        };
      }
    }

    const compiled = compileDiagram(parsed.spec, { title: options.title });
    const valid = await validateCompiledDiagram(compiled, options.validateMermaid);
    if (options.signal?.aborted) return { status: 'cancelled' };
    if (!valid.ok) {
      return {
        status: 'failed',
        message: `DocBlocks could not draw this diagram. ${valid.message}`,
      };
    }
    return { status: 'ready', spec: parsed.spec, compiled, notes: parsed.notes };
  }
}

const TIME_LABEL =
  /^(\d{4}|q[1-4]\b.*|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\.?(\s+\d{4})?)$/iu;

/**
 * A chart built straight from a markdown table, with no model call: the first
 * column labels the points and the first numeric column gives the values.
 */
export function tableChartSpec(tableMarkdown: string, title: string): ChartSpec | null {
  const table = parseMarkdown(tableMarkdown).children.find((node) => node.type === 'table');
  if (!table || table.type !== 'table') return null;
  const [header, ...rows] = table.children;
  if (!header || rows.length < 2) return null;
  const cell = (row: (typeof rows)[number], column: number) =>
    extractPlainText(row.children[column] ?? { type: 'text', value: '' }).trim();
  const width = Math.max(...rows.map((row) => row.children.length));
  for (let column = 1; column < width; column++) {
    const values = rows.map((row) => parseLooseNumber(cell(row, column)));
    if (values.some((value) => value === null)) continue;
    const labels = rows.map((row) => cell(row, 0)).slice(0, 12);
    return {
      kind: 'chart',
      type: labels.every((label) => TIME_LABEL.test(label)) ? 'line' : 'bar',
      title: title || cell(header, column),
      unit: cell(header, column),
      labels,
      values: (values as number[]).slice(0, labels.length),
    };
  }
  return null;
}

export type FindIdeasOutcome =
  | { readonly status: 'found'; readonly picks: readonly PlanPick[] }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'cancelled' };

/**
 * Phase one: pick the passages a picture would help and say what each picture
 * should show. One planning call, repaired at most once; no picture is drawn.
 */
export async function findIdeas(options: {
  ai: ChatApi;
  source: string;
  title: string;
  budget: PromptBudget;
  /** Offer design graphics in the plan. */
  design?: boolean;
  signal?: AbortSignal;
}): Promise<FindIdeasOutcome> {
  const passages = segmentPassages(options.source);
  if (passages.length === 0) return { status: 'found', picks: [] };
  const shortlist = shortlistPassages(passages, options.budget.passageCharacters);
  const design = options.design === true;
  const planRequest = buildPlanRequest({
    title: options.title,
    shortlist,
    budget: options.budget,
    design,
  });
  let reply = await chatOnce(options.ai, planRequest, options.signal);
  if (reply.kind === 'cancelled') return { status: 'cancelled' };
  if (reply.kind === 'error') return { status: 'failed', message: reply.error.message };
  let picks = parsePlanResponse(reply.text, shortlist, options.budget.maxSuggestions, design);
  if (picks === null) {
    reply = await chatOnce(
      options.ai,
      buildRepairRequest(planRequest, reply.text, 'It was not a JSON array.'),
      options.signal,
    );
    if (reply.kind === 'cancelled') return { status: 'cancelled' };
    if (reply.kind === 'error') return { status: 'failed', message: reply.error.message };
    picks = parsePlanResponse(reply.text, shortlist, options.budget.maxSuggestions, design);
  }
  if (picks === null) {
    return { status: 'failed', message: "The model's plan could not be read. Try again." };
  }
  return { status: 'found', picks };
}

export interface DrawOptions {
  readonly ai: ChatApi;
  readonly budget: PromptBudget;
  readonly validateMermaid: MermaidValidator;
  readonly signal?: AbortSignal;
}

/**
 * Phase two for one diagram idea. The idea's prompt says what to draw; its
 * passage supplies the facts. A numeric table asked for as a chart, as the
 * planner suggested it, is charted straight from its cells with no model call.
 */
export async function drawDiagram(
  idea: Omit<PlanPick, 'kind'> & { readonly kind: DiagramKind },
  options: DrawOptions & {
    /** The person wrote or changed the prompt, so its facts count as stated. */
    readonly personPrompt?: boolean;
    /** A summary of an earlier picture, so a redraw gives something different. */
    readonly avoid?: string;
  },
): Promise<DiagramOutcome> {
  if (
    idea.passage.kind === 'table' &&
    idea.kind === 'chart' &&
    !options.personPrompt &&
    !options.avoid
  ) {
    const spec = tableChartSpec(idea.passage.text, idea.title);
    if (spec) {
      const compiled = compileDiagram(spec, { title: idea.title });
      const valid = await validateCompiledDiagram(compiled, options.validateMermaid);
      if (valid.ok) return { status: 'ready', spec, compiled, notes: [] };
    }
  }
  return realizeDiagram({
    ai: options.ai,
    kind: idea.kind,
    material: idea.passage.plain,
    heading: idea.passage.heading,
    title: idea.title,
    description: idea.prompt || undefined,
    descriptionFacts: options.personPrompt,
    avoid: options.avoid,
    ground: true,
    budget: options.budget,
    validateMermaid: options.validateMermaid,
    signal: options.signal,
  });
}

export type IllustrationEvent =
  | { readonly type: 'planning' }
  | { readonly type: 'planned'; readonly picks: readonly PlanPick[] }
  | { readonly type: 'drawing'; readonly index: number; readonly total: number }
  | { readonly type: 'suggestion'; readonly pick: PlanPick; readonly outcome: DiagramOutcome }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'done'; readonly cancelled: boolean };

export interface IllustrationRun {
  readonly done: Promise<void>;
  cancel(): void;
}

/**
 * Both phases back to back, drawing every idea as the planner wrote it and
 * reporting progress through `onEvent`. The eval harness measures this; the
 * panel runs the phases separately so the person can edit ideas in between.
 */
export function startIllustrationRun(options: {
  ai: ChatApi;
  source: string;
  title: string;
  budget: PromptBudget;
  validateMermaid: MermaidValidator;
  onEvent: (event: IllustrationEvent) => void;
}): IllustrationRun {
  const controller = new AbortController();
  const { signal } = controller;
  const emit = options.onEvent;

  const run = async (): Promise<void> => {
    emit({ type: 'planning' });
    const found = await findIdeas({ ...options, signal });
    if (found.status === 'cancelled') return;
    if (found.status === 'failed') {
      emit({ type: 'error', message: found.message });
      return;
    }
    emit({ type: 'planned', picks: found.picks });
    for (const [index, pick] of found.picks.entries()) {
      if (signal.aborted) return;
      emit({ type: 'drawing', index, total: found.picks.length });
      // This run offers no design graphics, so the planner never returns one.
      if (pick.kind === 'design') continue;
      const outcome = await drawDiagram({ ...pick, kind: pick.kind }, { ...options, signal });
      if (outcome.status === 'cancelled') return;
      emit({ type: 'suggestion', pick, outcome });
    }
  };

  const done = run()
    .catch((error: unknown) => {
      emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => emit({ type: 'done', cancelled: signal.aborted }));
  return { done, cancel: () => controller.abort() };
}

/** Labels of a spec, for telling the model what to avoid on Regenerate. */
export function specSummaryForAvoid(compiled: CompiledDiagram): string {
  return `${compiled.title}: ${compiled.summary}`;
}

export type { Passage };
