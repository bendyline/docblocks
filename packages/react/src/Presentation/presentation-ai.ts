/** Optional, bounded editorial refinement of a deterministic Squisq plan.
 * Models choose display wording and layouts only. Source spans, order, media,
 * and timing remain owned by Squisq; failed suggestions retain the baseline.
 *
 * What the model is asked and how its reply is read are Squisq's
 * (`presentationAuthor` in `@bendyline/squisq/transform`): the prompts, the
 * reply shapes, and the gates that hold a reply to its passage. Every host
 * that words a deck shares them. This module only makes the calls: one for a
 * storyboard, then one per slide with a single correction.
 */
import type { AiResponseFormat, DocBlocksHostAiAPI } from '@bendyline/docblocks/host';
import {
  PRESENTATION_AUTHOR_LIMITS,
  PRESENTATION_SLIDE_FORMAT,
  PRESENTATION_STORYBOARD_FORMAT,
  presentationRetryContext,
  presentationSlidePrompt,
  presentationSlideRequest,
  presentationSlidesToWord,
  presentationStoryboardPrompt,
  presentationStoryboardRequest,
  presentationStoryboardTokens,
  presentationUsesStoryboard,
  readPresentationSlideReply,
  readPresentationStoryboardReply,
  type PresentationBeat,
  type PresentationLayout,
  type PresentationPlan,
  type PresentationSlideContext,
  type PresentationSlideReply,
} from '@bendyline/squisq/transform';
import { chatOnce } from '../Ai/chat-once.js';

/** Hosts that enforce structured output can return only the fields the reader
 * accepts. Without it, Apple's on-device model answers with a key per layout
 * name and every suggestion is rejected. */
const REFINEMENT_FORMAT: AiResponseFormat = { type: 'json_schema', ...PRESENTATION_SLIDE_FORMAT };
const STORYBOARD_FORMAT: AiResponseFormat = {
  type: 'json_schema',
  ...PRESENTATION_STORYBOARD_FORMAT,
};

/**
 * One request that plans every slide's layout together, so the deck varies
 * by design rather than slide by slide. Returns a layout for each beat the
 * model was asked about, or none when the reply does not name one layout
 * per slide.
 */
async function storyboard(
  ai: Pick<DocBlocksHostAiAPI, 'chat'>,
  plan: PresentationPlan,
  asked: readonly number[],
  signal?: AbortSignal,
): Promise<Map<number, PresentationLayout>> {
  const result = await chatOnce(
    ai,
    {
      purpose: 'illustrate',
      temperature: PRESENTATION_AUTHOR_LIMITS.temperature,
      maxTokens: presentationStoryboardTokens(asked.length),
      responseFormat: STORYBOARD_FORMAT,
      messages: [
        { role: 'system', content: presentationStoryboardPrompt() },
        { role: 'user', content: presentationStoryboardRequest(plan, asked) },
      ],
    },
    signal,
  );
  if (result.kind === 'cancelled')
    throw new DOMException('Presentation refinement cancelled.', 'AbortError');
  if (result.kind !== 'ok' || result.truncated) return new Map();
  return readPresentationStoryboardReply(result.text, plan, asked);
}

/** The slide a reply would show, or null when the automatic slide is kept. */
export function parsePresentationRefinement(
  text: string,
  plan: PresentationPlan,
  index: number,
): PresentationBeat | null {
  return readPresentationSlideReply(text, plan, index).beat;
}

export interface RefinePresentationOptions {
  signal?: AbortSignal;
  /** `completed` slides have resolved and a request for the next one is about to start. */
  onProgress?: (completed: number, total: number) => void;
  /**
   * One slide's outcome, as soon as it resolves and before the next request
   * starts: the accepted beat, or null when the automatic version is kept.
   * Lets a caller show suggestions while the remaining slides are still running.
   * Authored and hidden slides are never sent, so they have no outcome.
   */
  onBeat?: (index: number, beat: PresentationBeat | null) => void;
  /**
   * Each reply as it is read: why it was refused, or what was changed to keep
   * an accepted one faithful. For evaluations and diagnostics; the app shows
   * only outcomes.
   */
  onAttempt?: (
    index: number,
    attempt: number,
    outcome: { text: string; problem: string | null; notes: readonly string[] },
  ) => void;
}

export async function refinePresentationPlan(
  ai: Pick<DocBlocksHostAiAPI, 'chat'>,
  plan: PresentationPlan,
  options: RefinePresentationOptions = {},
): Promise<{ plan: PresentationPlan; retained: number; refined: number[] }> {
  const beats = [...plan.beats];
  let retained = 0;
  const refined: number[] = [];
  // An authored section keeps its own block and a hidden slide is not shown,
  // so neither has an outcome. A passage too long for a small model, or one
  // that addresses the model, keeps its automatic slide without being sent.
  const considered = plan.beats.flatMap((beat, index) =>
    beat.layout === 'authored' || beat.hidden ? [] : [index],
  );
  const asked = presentationSlidesToWord(plan);
  // A deck of a few slides plans its layouts together first; a short one, or
  // one too long for a small model to see at once, varies slide by slide.
  const planned = presentationUsesStoryboard(asked)
    ? await storyboard(ai, plan, asked, options.signal)
    : new Map<number, PresentationLayout>();
  for (const index of plan.beats.keys()) {
    options.signal?.throwIfAborted();
    options.onProgress?.(index, plan.beats.length);
    if (!considered.includes(index)) continue;
    if (!asked.includes(index)) {
      retained++;
      options.onBeat?.(index, null);
      continue;
    }
    let replacement: PresentationBeat | null = null;
    // The layout planned for this slide with the whole deck in view; without
    // a plan, the deck so far, so the model can vary its layouts.
    let context: PresentationSlideContext = planned.has(index)
      ? { planned: planned.get(index) }
      : { previous: beats.slice(Math.max(0, index - 3), index).map((b) => b.layout) };
    for (let attempt = 0; attempt < 2 && !replacement; attempt++) {
      const result = await chatOnce(
        ai,
        {
          // Hosts let only `write` reason. A reasoning model would spend this
          // small cap thinking and return an empty, truncated reply.
          purpose: 'illustrate',
          temperature: PRESENTATION_AUTHOR_LIMITS.temperature,
          maxTokens: PRESENTATION_AUTHOR_LIMITS.slideTokens,
          responseFormat: REFINEMENT_FORMAT,
          messages: [
            { role: 'system', content: presentationSlidePrompt() },
            { role: 'user', content: presentationSlideRequest(plan, index, context) },
          ],
        },
        options.signal,
      );
      if (result.kind === 'cancelled')
        throw new DOMException('Presentation refinement cancelled.', 'AbortError');
      if (result.kind === 'error') throw new Error(result.error.message);
      const read: PresentationSlideReply = result.truncated
        ? {
            beat: null,
            problem: 'the reply was cut off before it finished',
            kind: 'reply',
            notes: [],
          }
        : readPresentationSlideReply(result.text, plan, index);
      replacement = read.beat;
      options.onAttempt?.(index, attempt, {
        text: result.text,
        problem: read.problem ?? null,
        notes: read.notes,
      });
      // The second request says what was wrong with the first, and stops
      // asking for a planned layout the passage could not fill.
      context = presentationRetryContext(context, read);
    }
    if (replacement) {
      beats[index] = replacement;
      refined.push(index);
    } else retained++;
    options.onBeat?.(index, replacement);
  }
  options.onProgress?.(plan.beats.length, plan.beats.length);
  return {
    plan: { ...plan, origin: refined.length ? 'ai' : plan.origin, beats },
    retained,
    refined,
  };
}
