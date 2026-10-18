/**
 * Run the model calls that turn a document into a study aid.
 *
 * Calls run strictly one at a time, each awaiting the previous call's `done`:
 * the mobile host refuses a second operation until the first has released
 * its lock (see `illustrate-pipeline.ts`). One `AbortSignal` cancels the run
 * between or during calls; nothing is saved here, so a cancelled or failed
 * run leaves any earlier study aid untouched.
 *
 * A summary of a document that fits one call is written in one pass. A
 * longer one is read part by part into notes, and the summary is written
 * from the notes. Quiz questions and flashcards are asked for part by part,
 * in proportion to each part's length, then checked against the part they
 * came from and compiled (`study-compile.ts`).
 */

import type {
  AiChatEvent,
  AiChatRequest,
  AiModelInfo,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';
import { buildDraftContinuation, sanitizeGeneratedMarkdown } from './ai-assistant.js';
import { stripReasoning } from './ai-json.js';
import { clipPassage, documentTitle } from './illustrate-passages.js';
import { chatOnce, type ChatOutcome } from './illustrate-pipeline.js';
import { buildRepairRequest } from './illustrate-prompts.js';
import { studySourceDigest, type StudyAidKind, type StudyAidProvenance } from './study-aids.js';
import {
  assembleDeck,
  assembleSummary,
  cardIsValid,
  compileSummaryBody,
  flashcardGrounded,
  quizItemGrounded,
  renderFlashcard,
  renderQuizCard,
} from './study-compile.js';
import {
  buildFlashcardRequest,
  buildNotesRequest,
  buildQuizRequest,
  buildSummaryRequest,
  itemKey,
  readFlashcardItem,
  readItems,
  readQuizItem,
  type FlashcardItem,
  type QuizItem,
} from './study-prompts.js';
import {
  chunkStudySections,
  segmentStudySections,
  studyCharacters,
  type StudyBudget,
  type StudyChunk,
} from './study-sections.js';

type ChatApi = Pick<DocBlocksHostAiAPI, 'chat'>;

/** Where a run is, for the dialog's status line. */
export type StudyStage =
  | { readonly kind: 'notes'; readonly part: number; readonly parts: number }
  | { readonly kind: 'condensing' }
  | { readonly kind: 'writing' }
  | { readonly kind: 'items'; readonly step: number; readonly steps: number };

export type StudyOutcome =
  | {
      readonly status: 'ready';
      /** The complete document to save, frontmatter included. */
      readonly markdown: string;
      /** Questions or cards in a deck; null for a summary. */
      readonly count: number | null;
      /** Things the person should know about how it was made. */
      readonly notes: readonly string[];
    }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'cancelled' };

export interface StudyOptions {
  readonly ai: ChatApi;
  readonly kind: StudyAidKind;
  /** The document's Markdown as it stood when the run started. */
  readonly source: string;
  /** The document's file name, recorded in the saved file. */
  readonly sourceName: string;
  readonly model: AiModelInfo | null;
  readonly budget: StudyBudget;
  readonly signal?: AbortSignal;
  readonly onStage?: (stage: StudyStage) => void;
  /** Each call's progress and deltas, for a status line. */
  readonly onEvent?: (event: AiChatEvent) => void;
  /** The clock stamped into the saved file; tests pin it. */
  readonly now?: () => Date;
}

/** Fewest characters of prose worth making a study aid from. */
export const MIN_STUDY_CHARACTERS = 120;
/** Most questions in a quiz, and cards in a deck. */
export const QUIZ_QUESTIONS = 10;
export const FLASHCARD_CARDS = 20;
/** About one question or card for this many characters of prose, up to the caps. */
const CHARACTERS_PER_ITEM = 400;

const CANCELLED: StudyOutcome = { status: 'cancelled' };

function failed(message: string): StudyOutcome {
  return { status: 'failed', message };
}

/** Stop the run on anything but a reply. */
function interrupted(outcome: Exclude<ChatOutcome, { kind: 'ok' }>): StudyOutcome {
  return outcome.kind === 'cancelled' ? CANCELLED : failed(outcome.error.message);
}

interface Run {
  readonly options: StudyOptions;
  readonly title: string;
  readonly notes: string[];
  call(request: AiChatRequest): Promise<ChatOutcome>;
}

/** Make the study aid `options.kind` from `options.source`. */
export async function generateStudyAid(options: StudyOptions): Promise<StudyOutcome> {
  const sections = segmentStudySections(options.source);
  if (studyCharacters(sections) < MIN_STUDY_CHARACTERS) {
    return failed('This document has too little text to work from. Add more and try again.');
  }
  const chunking = chunkStudySections(sections, options.budget);
  const { model, signal } = options;
  const run: Run = {
    options,
    // A heading's emphasis and code marks would show as literal characters.
    title: (documentTitle(options.source) || options.sourceName.replace(/\.[^.]+$/u, ''))
      .replace(/[*`]/gu, '')
      .trim(),
    notes: chunking.shortened
      ? [
          'This is a long document for the model, so parts of each section were shortened before it read them.',
        ]
      : [],
    call: (request) =>
      chatOnce(
        options.ai,
        model ? { ...request, model: model.id } : request,
        signal,
        options.onEvent,
      ),
  };

  const digest = await studySourceDigest(options.source);
  if (signal?.aborted) return CANCELLED;
  const provenance = (): StudyAidProvenance => ({
    kind: options.kind,
    source: options.sourceName,
    sourceSha256: digest,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    model: model?.label ?? null,
  });

  if (options.kind === 'summary') {
    const body = await summarize(run, chunking.chunks);
    if (typeof body !== 'string') return body;
    return {
      status: 'ready',
      markdown: assembleSummary(body, run.title, provenance()),
      count: null,
      notes: run.notes,
    };
  }

  const target = Math.min(
    options.kind === 'quiz' ? QUIZ_QUESTIONS : FLASHCARD_CARDS,
    Math.max(3, Math.round(studyCharacters(sections) / CHARACTERS_PER_ITEM)),
  );
  const cards =
    options.kind === 'quiz'
      ? await writeItems(run, chunking.chunks, target, QUIZ)
      : await writeItems(run, chunking.chunks, target, FLASHCARDS);
  if (!Array.isArray(cards)) return cards;
  return {
    status: 'ready',
    markdown: assembleDeck(options.kind, cards, run.title, provenance()),
    count: cards.length,
    notes: run.notes,
  };
}

// ─── Summary ───────────────────────────────────────────────

function cleanNotes(reply: string): string {
  return sanitizeGeneratedMarkdown(stripReasoning(reply));
}

function joinNotes(notes: readonly string[]): string {
  return notes.map((note, index) => `Part ${String(index + 1)}:\n${note}`).join('\n\n');
}

/** Notes grouped so each group's text fits one call. */
function batchNotes(notes: readonly string[], max: number): string[] {
  const batches: string[] = [];
  let current = '';
  for (const note of notes.map((text) => clipPassage(text, max))) {
    if (current && current.length + 2 + note.length > max) {
      batches.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${note}` : note;
  }
  if (current) batches.push(current);
  return batches;
}

/** Notes short enough for the final call: condensed at most twice, then clipped. */
async function fitNotes(run: Run, notes: readonly string[]): Promise<string | StudyOutcome> {
  const { budget, onStage } = run.options;
  let current = notes;
  for (let round = 0; round < 2; round++) {
    const joined = joinNotes(current);
    if (joined.length <= budget.chunkCharacters) return joined;
    onStage?.({ kind: 'condensing' });
    const batches = batchNotes(current, budget.chunkCharacters);
    const next: string[] = [];
    for (const [index, batch] of batches.entries()) {
      const outcome = await run.call(
        buildNotesRequest({
          title: run.title,
          material: batch,
          part: index + 1,
          parts: batches.length,
          condense: true,
          maxTokens: budget.notesTokens,
        }),
      );
      if (outcome.kind !== 'ok') return interrupted(outcome);
      const text = cleanNotes(outcome.text);
      if (text) next.push(text);
    }
    current = next;
  }
  return clipPassage(joinNotes(current), budget.chunkCharacters);
}

/** The summary's body, or how the run ended without one. */
async function summarize(run: Run, chunks: readonly StudyChunk[]): Promise<string | StudyOutcome> {
  const { budget, onStage } = run.options;
  let material = chunks[0]?.text ?? '';
  const fromNotes = chunks.length > 1;
  if (fromNotes) {
    const notes: string[] = [];
    for (const chunk of chunks) {
      onStage?.({ kind: 'notes', part: chunk.index + 1, parts: chunks.length });
      const outcome = await run.call(
        buildNotesRequest({
          title: run.title,
          material: chunk.text,
          part: chunk.index + 1,
          parts: chunks.length,
          condense: false,
          maxTokens: budget.notesTokens,
        }),
      );
      if (outcome.kind !== 'ok') return interrupted(outcome);
      const text = cleanNotes(outcome.text);
      if (text) notes.push(text);
    }
    if (notes.length === 0) return failed('The model wrote no notes on this document. Try again.');
    const fitted = await fitNotes(run, notes);
    if (typeof fitted !== 'string') return fitted;
    material = fitted;
  }

  onStage?.({ kind: 'writing' });
  const request = buildSummaryRequest({
    title: run.title,
    material,
    fromNotes,
    maxTokens: budget.summaryTokens,
  });
  const outcome = await run.call(request);
  if (outcome.kind !== 'ok') return interrupted(outcome);
  let text = outcome.text;
  if (outcome.truncated) {
    // One continuation; the summary is short, so a second cut-off means the
    // model is rambling and what it has written is kept.
    const more = await run.call(buildDraftContinuation(request, text));
    if (more.kind === 'cancelled') return CANCELLED;
    if (more.kind === 'ok') text += more.text;
    if (more.kind !== 'ok' || more.truncated) {
      run.notes.push('The summary may be incomplete: the model reached its length limit.');
    }
  }
  const body = compileSummaryBody(text);
  return body || failed('The model returned an empty summary. Try again.');
}

// ─── Quiz and flashcards ───────────────────────────────────

interface ItemKind<T> {
  /** Plural noun for messages: "questions", "flashcards". */
  readonly noun: string;
  build(options: {
    title: string;
    material: string;
    count: number;
    avoid: readonly string[];
    maxTokens: number;
  }): AiChatRequest;
  read(raw: unknown): T | null;
  /** The text that identifies the item, for spotting repeats. */
  label(item: T): string;
  grounded(item: T, material: string): boolean;
  render(item: T, number: number): string | null;
  valid(card: string): boolean;
}

const QUIZ: ItemKind<QuizItem> = {
  noun: 'questions',
  build: buildQuizRequest,
  read: readQuizItem,
  label: (item) => item.question,
  grounded: quizItemGrounded,
  render: renderQuizCard,
  // The question is a `###` heading too; every other one is a choice.
  valid: (card) => cardIsValid(card, 'multiple-choice', (card.match(/^### /gmu)?.length ?? 1) - 1),
};

const FLASHCARDS: ItemKind<FlashcardItem> = {
  noun: 'flashcards',
  build: buildFlashcardRequest,
  read: readFlashcardItem,
  label: (item) => item.front,
  grounded: flashcardGrounded,
  render: (item) => renderFlashcard(item),
  valid: (card) => cardIsValid(card, 'basic'),
};

type ItemsResult<T> =
  | { readonly kind: 'items'; readonly items: readonly T[] }
  | { readonly kind: 'unusable' }
  | { readonly kind: 'stopped'; readonly outcome: StudyOutcome };

/** One call for `count` items from `chunk`, repaired or retried at most once. */
async function requestItems<T>(
  run: Run,
  spec: ItemKind<T>,
  chunk: StudyChunk,
  count: number,
  avoid: readonly string[],
): Promise<ItemsResult<T>> {
  const { budget } = run.options;
  const request = spec.build({
    title: run.title,
    material: chunk.text,
    count,
    avoid,
    maxTokens: budget.itemTokens,
  });
  const outcome = await run.call(request);
  if (outcome.kind !== 'ok') return { kind: 'stopped', outcome: interrupted(outcome) };
  const reading = readItems(outcome.text, spec.read);
  if (reading.ok) return { kind: 'items', items: reading.items };
  // Cut off before finishing one item: ask for fewer rather than more room,
  // which a small context window cannot spare. Otherwise name the problem.
  const retry = outcome.truncated
    ? spec.build({
        title: run.title,
        material: chunk.text,
        count: Math.max(1, Math.floor(count / 2)),
        avoid,
        maxTokens: budget.itemTokens,
      })
    : buildRepairRequest(request, outcome.text, reading.problem, 'array');
  const second = await run.call(retry);
  if (second.kind !== 'ok') return { kind: 'stopped', outcome: interrupted(second) };
  const again = readItems(second.text, spec.read);
  return again.ok ? { kind: 'items', items: again.items } : { kind: 'unusable' };
}

/**
 * Compiled cards from every part, `target` in all, shared out by each part's
 * length. A host error ends the run, keeping the cards already written; a
 * reply that cannot be used skips that part.
 */
async function writeItems<T>(
  run: Run,
  chunks: readonly StudyChunk[],
  target: number,
  spec: ItemKind<T>,
): Promise<string[] | StudyOutcome> {
  const { budget, onStage } = run.options;
  const total = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) || 1;
  const calls: { chunk: StudyChunk; count: number }[] = [];
  for (const chunk of chunks) {
    let left = Math.max(1, Math.round((target * chunk.text.length) / total));
    while (left > 0) {
      const count = Math.min(left, budget.itemsPerCall);
      calls.push({ chunk, count });
      left -= count;
    }
  }

  const cards: string[] = [];
  const seen = new Set<string>();
  const asked = new Map<number, string[]>();
  let unusable = 0;
  for (const [index, { chunk, count }] of calls.entries()) {
    onStage?.({ kind: 'items', step: index + 1, steps: calls.length });
    const avoid = asked.get(chunk.index) ?? [];
    const result = await requestItems(run, spec, chunk, count, avoid);
    if (result.kind === 'stopped') {
      if (result.outcome.status === 'cancelled' || cards.length === 0) return result.outcome;
      run.notes.push(
        `The model stopped before finishing, so there are fewer ${spec.noun} than planned.`,
      );
      break;
    }
    if (result.kind === 'unusable') {
      unusable++;
      continue;
    }
    let kept = 0;
    for (const item of result.items) {
      if (kept >= count) break;
      const key = itemKey(spec.label(item));
      if (!key || seen.has(key) || !spec.grounded(item, chunk.text)) continue;
      const card = spec.render(item, cards.length + 1);
      if (!card || !spec.valid(card)) continue;
      seen.add(key);
      avoid.push(spec.label(item));
      cards.push(card);
      kept++;
    }
    asked.set(chunk.index, avoid);
  }
  if (cards.length === 0) {
    return failed(`The model's ${spec.noun} could not be used. Try again.`);
  }
  if (unusable > 0) {
    run.notes.push(`Some parts of the document could not be turned into ${spec.noun}.`);
  }
  return cards;
}
