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
 * from the notes. (Quiz questions and flashcards are study cards kept with
 * each section, made in Squisq's Study cards view — see `Study/`.)
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
import { chatOnce, type ChatOutcome } from './chat-once.js';
import { studySourceDigest, type StudyAidKind, type StudyAidProvenance } from './study-aids.js';
import { assembleSummary, compileSummaryBody } from './study-compile.js';
import { buildNotesRequest, buildSummaryRequest } from './study-prompts.js';
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
  | { readonly kind: 'writing' };

export type StudyOutcome =
  | {
      readonly status: 'ready';
      /** The complete document to save, frontmatter included. */
      readonly markdown: string;
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

  const body = await summarize(run, chunking.chunks);
  if (typeof body !== 'string') return body;
  return {
    status: 'ready',
    markdown: assembleSummary(body, run.title, provenance()),
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
