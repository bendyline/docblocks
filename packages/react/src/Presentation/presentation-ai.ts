/** Optional, bounded editorial refinement of a deterministic Squisq plan.
 * Models choose display wording and layouts only. Source spans, order, media,
 * and timing remain owned by Squisq; failed suggestions retain the baseline.
 *
 * Everything about wording a deck except the transport is Squisq's
 * (`@bendyline/squisq/transform`): the prompts, the reply shapes, the gates
 * that hold a reply to its passage, and the loop that runs them
 * (`wordPresentationPlan` — a storyboard, then one request per slide with a
 * single correction). This module is only the transport: it sends each of
 * Squisq's requests through the host's chat.
 */
import type { AiResponseFormat, DocBlocksHostAiAPI } from '@bendyline/docblocks/host';
import {
  wordPresentationPlan,
  type PresentationModel,
  type PresentationPlan,
  type WordPresentationOptions,
  type WordPresentationResult,
} from '@bendyline/squisq/transform';
import { chatOnce } from '../Ai/chat-once.js';

/** Sends one of Squisq's wording requests through the host's chat. */
export function presentationModel(ai: Pick<DocBlocksHostAiAPI, 'chat'>): PresentationModel {
  return async (request, signal) => {
    // Hosts that enforce structured output can return only the fields the
    // reader accepts. Without it, Apple's on-device model answers with a key
    // per layout name and every suggestion is rejected.
    const responseFormat: AiResponseFormat = { type: 'json_schema', ...request.responseFormat };
    const result = await chatOnce(
      ai,
      {
        // Hosts let only `write` reason. A reasoning model would spend this
        // small cap thinking and return an empty, truncated reply.
        purpose: 'illustrate',
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        responseFormat,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
      },
      signal,
    );
    if (result.kind === 'cancelled')
      throw new DOMException('Presentation refinement cancelled.', 'AbortError');
    if (result.kind === 'error') throw new Error(result.error.message);
    return { text: result.text, truncated: result.truncated };
  };
}

export type RefinePresentationOptions = WordPresentationOptions;

/** Word a deck with the host's model, through Squisq's `wordPresentationPlan`. */
export function refinePresentationPlan(
  ai: Pick<DocBlocksHostAiAPI, 'chat'>,
  plan: PresentationPlan,
  options: RefinePresentationOptions = {},
): Promise<WordPresentationResult> {
  return wordPresentationPlan(plan, presentationModel(ai), options);
}
