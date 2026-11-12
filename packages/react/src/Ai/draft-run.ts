/**
 * A draft, without a UI: Compose (new content at the cursor) and Rewrite.
 *
 * The draft dialog streams a reply into an editable box and lets the person
 * continue a draft that stopped at the model's limit. How a finished reply
 * becomes the text that is inserted is shared here, so the dialog and the
 * docbench task pack ({@link runDraft}) read a draft identically.
 */

import type { AiChatRequest } from '@bendyline/docblocks/host';
import {
  buildDraftContinuation,
  sanitizeGeneratedMarkdown,
  type AiDraftMode,
} from './ai-assistant.js';
import { chatOnce, type ChatApi } from './chat-once.js';
import { withoutDocumentEcho } from './draft-echo.js';

export interface SettledDraft {
  /** The draft so far: the reply cleaned up when it finished in one go, else raw. */
  readonly draft: string;
  /** The model finished: it stopped on its own and, for a continuation, added something. */
  readonly finished: boolean;
  /** A continuation came back empty, so asking again is no help. */
  readonly emptyContinuation: boolean;
  /** Document text the model copied into new content was removed from the draft. */
  readonly echoRemoved: boolean;
}

/**
 * Settle one reply onto the draft so far (`prefix`, empty for a first reply).
 * Whitespace at a join is kept: the preceding reply may end mid-word or
 * mid-table, so a continuation is never cleaned up on its own.
 */
export function settleDraft(
  prefix: string,
  reply: { readonly text: string; readonly finishReason: 'stop' | 'length' | 'cancelled' },
  documentSource: string,
  mode: AiDraftMode,
): SettledDraft {
  const emptyContinuation = Boolean(prefix) && !reply.text.trim();
  const finished = reply.finishReason === 'stop' && !emptyContinuation;
  const draft =
    prefix || !finished
      ? prefix + reply.text
      : sanitizeGeneratedMarkdown(reply.text, documentSource);
  // New content is inserted into the document it was written from, so
  // document text the model copied into it would appear twice.
  const echo =
    mode === 'compose' && !prefix
      ? withoutDocumentEcho(draft, documentSource, { trailing: finished })
      : null;
  return {
    draft: echo?.text ?? draft,
    finished,
    emptyContinuation,
    echoRemoved: echo?.removed ?? false,
  };
}

/** The text Insert or Replace puts into the document. */
export function draftToApply(draft: string, documentSource: string): string {
  return sanitizeGeneratedMarkdown(draft, documentSource);
}

export interface DraftResult {
  /** What Insert or Replace would put into the document; empty when there is nothing. */
  readonly text: string;
  readonly finished: boolean;
  /** Continuations asked for after a reply stopped at the model's limit. */
  readonly continuations: number;
  readonly requests: number;
  readonly error: string | null;
}

/**
 * Draft straight through, as a person who presses Continue whenever the
 * dialog offers it would, up to `maxContinuations` times.
 */
export async function runDraft(
  ai: ChatApi,
  request: AiChatRequest,
  documentSource: string,
  mode: AiDraftMode,
  options: { readonly maxContinuations?: number; readonly signal?: AbortSignal } = {},
): Promise<DraftResult> {
  let draft = '';
  let continuations = 0;
  let requests = 0;
  for (;;) {
    const next = draft ? buildDraftContinuation(request, draft) : request;
    requests += 1;
    const outcome = await chatOnce(ai, next, options.signal);
    if (outcome.kind !== 'ok') {
      return {
        text: draftToApply(draft, documentSource),
        finished: false,
        continuations,
        requests,
        error: outcome.kind === 'cancelled' ? 'cancelled' : outcome.error.message,
      };
    }
    const settled = settleDraft(
      draft,
      { text: outcome.text, finishReason: outcome.truncated ? 'length' : 'stop' },
      documentSource,
      mode,
    );
    draft = settled.draft;
    const canContinue =
      !settled.finished &&
      !settled.emptyContinuation &&
      Boolean(draft.trim()) &&
      continuations < (options.maxContinuations ?? 1);
    if (!canContinue) {
      return {
        text: draftToApply(draft, documentSource),
        finished: settled.finished,
        continuations,
        requests,
        error: null,
      };
    }
    continuations += 1;
  }
}
