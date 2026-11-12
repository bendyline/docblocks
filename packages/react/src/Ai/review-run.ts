/**
 * The review loop, without a UI.
 *
 * A review sends one request per part of the document, one at a time. A reply
 * that fills its room (a small model's few findings, or a reply cut off at its
 * limit) is followed by another request about the same part for the issues it
 * had no room for, until one comes back with nothing new or the passes run
 * out. The review panel drives these steps itself, because it can stop, skip
 * a part, and continue; {@link reviewDocument} drives them straight through,
 * for the docbench task pack. Both read every reply through
 * {@link readReviewReply}, so a benchmark scores exactly what a person sees.
 */

import type { AiChatRequest } from '@bendyline/docblocks/host';
import {
  AI_REVIEW_DOCUMENT_CHARACTERS,
  REVIEW_PASSES,
  aiReviewReplyWasCutOff,
  buildReviewFollowUp,
  buildReviewRequests,
  parseAiReviewResponse,
  parseTruncatedAiReviewResponse,
  reviewDocumentCharacters,
  withoutPictureFindings,
  type AiReviewFinding,
} from './ai-assistant.js';
import { chatOnce, type ChatApi } from './chat-once.js';
import { reviewFindingLimit } from './review-parts.js';
import type { AiReviewStyle } from './review-styles.js';

/** A review in progress: one request per part, sent one at a time. */
export interface ReviewRun {
  readonly style: AiReviewStyle;
  /** The document as reviewed; findings that touch its pictures are dropped. */
  readonly source: string;
  readonly requests: readonly AiChatRequest[];
  /** Most findings each request asks for, or null for every one. */
  readonly findings: number | null;
}

export const REVIEW_TOO_LONG_MESSAGE =
  'This document is too long for one AI review pass. Review a shorter document.';

export type ReviewStart =
  /** Nothing to review: the review is done, with no findings. */
  | { readonly kind: 'empty' }
  | { readonly kind: 'too-long'; readonly message: string }
  | { readonly kind: 'run'; readonly run: ReviewRun };

/** Plan the review of `source`, sized for a model with `contextWindow`. */
export function startReviewRun(
  source: string,
  style: AiReviewStyle,
  contextWindow: number | null,
  now: Date = new Date(),
): ReviewStart {
  if (!source.trim()) return { kind: 'empty' };
  if (reviewDocumentCharacters(source) > AI_REVIEW_DOCUMENT_CHARACTERS) {
    return { kind: 'too-long', message: REVIEW_TOO_LONG_MESSAGE };
  }
  return {
    kind: 'run',
    run: {
      style,
      source,
      requests: buildReviewRequests(source, style, contextWindow, now),
      findings: reviewFindingLimit(contextWindow),
    },
  };
}

/** One request of a review: a part, which pass over it, and what it already reported. */
export interface ReviewStep {
  readonly part: number;
  /** 0 for the part's own request; more for a follow-up asking it for more. */
  readonly pass: number;
  /** The quotes of findings already reported for this part. */
  readonly reported: readonly string[];
}

/** The request to send for `step`. */
export function reviewStepRequest(run: ReviewRun, step: ReviewStep): AiChatRequest {
  const request = run.requests[step.part];
  if (!request) throw new RangeError(`The review has no part ${String(step.part)}.`);
  return step.pass === 0 ? request : buildReviewFollowUp(request, step.reported);
}

export interface ReviewReply {
  readonly text: string;
  /** The reply stopped at its output limit. */
  readonly truncated: boolean;
}

export type ReviewReplyResult =
  /** The reply could not be read; on a first pass this ends the review. */
  | { readonly kind: 'unreadable'; readonly message: string }
  | {
      readonly kind: 'read';
      /** Findings not already reported, picture findings removed. */
      readonly fresh: readonly AiReviewFinding[];
      /** Findings the reply held in a shape DocBlocks could not use, left out. */
      readonly dropped: number;
      /** Ask the same part for more next. */
      readonly followUp: ReviewStep | null;
      /** The reply filled its room and no passes are left: there may be more issues. */
      readonly cutOff: boolean;
    };

/** Read one reply the way the review panel does. */
export function readReviewReply(
  run: ReviewRun,
  step: ReviewStep,
  reply: ReviewReply,
): ReviewReplyResult {
  // A model with a small reply limit (Apple's on-device model stops at
  // 1,024 tokens) can stop partway through a finding. Keep the ones it
  // finished rather than discarding the whole review.
  const truncated = reply.truncated || aiReviewReplyWasCutOff(reply.text);
  const parsed = truncated
    ? parseTruncatedAiReviewResponse(reply.text)
    : parseAiReviewResponse(reply.text);
  if (!parsed || (truncated && parsed.findings.length === 0)) {
    // A cut-off reply comes out the same each time, so retrying is no help.
    return {
      kind: 'unreadable',
      message: truncated
        ? "The AI's reply was cut off before it finished a single finding. Try a shorter " +
          'document, or choose a different model in AI settings.'
        : run.requests.length > 1
          ? 'The AI returned a review DocBlocks could not read.'
          : 'The AI returned a review DocBlocks could not read. Try reviewing again.',
    };
  }
  // A small model asked for more often repeats itself.
  const already = new Set(step.reported);
  const fresh = withoutPictureFindings(parsed.findings, run.source).filter(
    (finding) => !already.has(finding.originalText),
  );
  const { dropped } = parsed;
  // A reply that used its room on findings left out still filled it.
  const full =
    truncated || (run.findings !== null && parsed.findings.length + dropped >= run.findings);
  if (full && fresh.length > 0) {
    if (step.pass + 1 < REVIEW_PASSES) {
      return {
        kind: 'read',
        fresh,
        dropped,
        followUp: {
          part: step.part,
          pass: step.pass + 1,
          reported: [...step.reported, ...fresh.map((finding) => finding.originalText)],
        },
        cutOff: false,
      };
    }
    return { kind: 'read', fresh, dropped, followUp: null, cutOff: true };
  }
  return { kind: 'read', fresh, dropped, followUp: null, cutOff: false };
}

/** Number findings in the order they arrived, as the panel does. */
export function numberReviewFindings(
  existing: readonly AiReviewFinding[],
  fresh: readonly AiReviewFinding[],
): AiReviewFinding[] {
  return [
    ...existing,
    ...fresh.map((finding, offset) => ({
      ...finding,
      id: `ai-review-${String(existing.length + offset + 1)}`,
    })),
  ];
}

export interface ReviewResult {
  readonly findings: readonly AiReviewFinding[];
  /** Some issues may be missing: a follow-up failed or the passes ran out. */
  readonly cutOff: boolean;
  /** Findings the AI returned that DocBlocks could not read, left out as the panel notes. */
  readonly dropped: number;
  /** Why the review stopped early, or null when every part was reviewed. */
  readonly error: string | null;
  readonly partsDone: number;
  readonly requests: number;
}

/**
 * Review a whole document, part by part, straight through: the panel's loop
 * with no stopping or skipping. Resolves with what a person would have been
 * shown; a cancelled review resolves with what had arrived.
 */
export async function reviewDocument(
  ai: ChatApi,
  run: ReviewRun,
  signal?: AbortSignal,
): Promise<ReviewResult> {
  let findings: AiReviewFinding[] = [];
  let cutOff = false;
  let dropped = 0;
  let partsDone = 0;
  let requests = 0;
  for (let part = 0; part < run.requests.length; part += 1) {
    let step: ReviewStep | null = { part, pass: 0, reported: [] };
    while (step) {
      const current: ReviewStep = step;
      requests += 1;
      const outcome = await chatOnce(ai, reviewStepRequest(run, current), signal);
      if (outcome.kind === 'cancelled') {
        return { findings, cutOff, dropped, error: 'cancelled', partsDone, requests };
      }
      const result: ReviewReplyResult =
        outcome.kind === 'error'
          ? { kind: 'unreadable', message: outcome.error.message }
          : readReviewReply(run, current, { text: outcome.text, truncated: outcome.truncated });
      if (result.kind === 'unreadable') {
        // A follow-up only looks for more: when it fails, the part's own
        // findings still stand, so the review moves on and says there may be more.
        if (current.pass > 0) {
          cutOff = true;
          break;
        }
        return { findings, cutOff, dropped, error: result.message, partsDone, requests };
      }
      findings = numberReviewFindings(findings, result.fresh);
      dropped += result.dropped;
      if (current.pass === 0) partsDone = part + 1;
      if (result.cutOff) cutOff = true;
      step = result.followUp;
    }
  }
  return { findings, cutOff, dropped, error: null, partsDone, requests };
}
