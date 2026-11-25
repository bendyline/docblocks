/**
 * DocBlocks' transport for Squisq's study card protocol.
 *
 * Everything about making study cards except the transport is Squisq's
 * (`@bendyline/squisq/study`): the prompts, the reply formats, the checks
 * each card must pass, and the loop (`generateStudyCards` — one section and
 * one request at a time, one repair). This module only sends each request
 * through the host's chat and says how much the model can hold.
 *
 * Requests use the `study` purpose (only `write` may reason: a reasoning
 * model would spend a small reply cap thinking) and never search knowledge:
 * a card must come from its own section, and a knowledge passage would eat a
 * small model's window.
 */
import type { AiModelInfo, AiResponseFormat, DocBlocksHostAiAPI } from '@bendyline/docblocks/host';
import {
  generateStudyCards as runStudyCards,
  type GenerateStudyCardsOptions,
  type GenerateStudyCardsResult,
  type StudyModel,
  type StudyModelLimits,
  type StudySection,
} from '@bendyline/squisq/study';
import { chatOnce } from '../Ai/chat-once.js';

/** Hosts reject a reply cap above this. */
const MAX_REPLY_TOKENS = 32_768;
/** Below this window a model counts as small, and small models stop replies at 1,024 tokens. */
const SMALL_CONTEXT = 16_384;

/** Sends one of Squisq's study card requests through the host's chat. */
export function studyModel(ai: Pick<DocBlocksHostAiAPI, 'chat'>, modelId?: string): StudyModel {
  return async (request, signal) => {
    // Hosts that enforce structured output return only the fields asked for;
    // phones do not, and Squisq reads their replies leniently.
    const responseFormat: AiResponseFormat = { type: 'json_schema', ...request.responseFormat };
    const result = await chatOnce(
      ai,
      {
        purpose: 'study',
        searchKnowledge: false,
        ...(modelId ? { model: modelId } : {}),
        temperature: Math.min(2, Math.max(0, request.temperature)),
        maxTokens: Math.min(MAX_REPLY_TOKENS, Math.max(1, Math.round(request.maxTokens))),
        responseFormat,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
      },
      signal,
    );
    if (result.kind === 'cancelled') throw new DOMException('Making cards stopped.', 'AbortError');
    if (result.kind === 'error') throw new Error(result.error.message);
    return { text: result.text, truncated: result.truncated };
  };
}

/** What the model can hold, from what the host knows about it. */
export function studyModelLimits(
  model: Pick<AiModelInfo, 'contextWindow' | 'system'> | null | undefined,
): StudyModelLimits {
  const contextTokens =
    model?.contextWindow && model.contextWindow > 0 ? model.contextWindow : 4_096;
  // Apple's on-device model (and every small model we run) stops a reply at 1,024 tokens.
  const small = !!model?.system || contextTokens < SMALL_CONTEXT;
  return { contextTokens, maxReplyTokens: small ? 1_024 : null };
}

/** The model a run uses, as far as the host knows it. */
export type StudyModelInfo = Partial<Pick<AiModelInfo, 'id' | 'system'>> &
  Pick<AiModelInfo, 'contextWindow'>;

/**
 * Make study cards through Squisq's `generateStudyCards`, sized for `model`
 * (the host's ready model; unknown counts as a small one).
 */
export function generateStudyCards(
  ai: Pick<DocBlocksHostAiAPI, 'chat'>,
  sections: readonly StudySection[],
  options: Omit<GenerateStudyCardsOptions, 'limits'> & { model?: StudyModelInfo | null },
): Promise<GenerateStudyCardsResult> {
  const { model, ...rest } = options;
  return runStudyCards(sections, studyModel(ai, model?.id), {
    ...rest,
    limits: studyModelLimits(model),
  });
}
