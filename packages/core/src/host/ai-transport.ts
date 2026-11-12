/**
 * The OpenAI-compatible chat body DocBlocks sends for one {@link AiChatRequest}.
 *
 * The desktop host sends it to Gezel, and the docbench task pack sends it to
 * the model under test, so a benchmark measures exactly the request a person's
 * editor makes. The rules here are product policy, each evaluated against real
 * models before it was adopted:
 *
 * - Only `write` may reason. Every other purpose sends `reasoning_effort:
 *   'none'`: a thinking model asked for a quiz or a review spent its whole
 *   explicit cap reasoning and returned no JSON.
 * - A local writing request without its own cap may use the whole context
 *   window, so a long draft is not cut short by an engine default.
 * - Structured output is asked for only when the caller gave a schema.
 *
 * Streaming options and knowledge passages are the transport's business, not
 * the body's; callers add them.
 */

import type { AiChatPurpose, AiResponseFormat } from './ai.js';

/** A chat message as DocBlocks writes one; a transport may carry a wider message type. */
export interface ChatCompletionMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ChatCompletionBodyInput<Message = ChatCompletionMessage> {
  /** Qualified provider model id, such as `llama-cpp:gemma4-e4b-q4`. */
  readonly model: string;
  /** Sent as given: the body copies the list, never the messages. */
  readonly messages: readonly Message[];
  readonly purpose?: AiChatPurpose;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly responseFormat?: AiResponseFormat;
  /** The model's context window, used as a local writing request's default cap. */
  readonly contextWindow?: number | null;
}

export interface ChatCompletionBodyOptions {
  /**
   * A sampling seed. The product never sends one; a benchmark does, so a
   * repeated trial is a different sample and a re-run is the same one.
   */
  readonly seed?: number;
}

export interface ChatCompletionBody<Message = ChatCompletionMessage> {
  model: string;
  messages: Message[];
  reasoning_effort?: 'none';
  temperature?: number;
  max_tokens?: number;
  seed?: number;
  response_format?: {
    type: 'json_schema';
    json_schema: { name: string; schema: Record<string, unknown>; strict: true };
  };
}

/** Engines that run on the person's own machine, named by the model id's provider prefix. */
const LOCAL_ENGINE_MODEL = /^(?:mlx|llama-cpp|ollama|ds4):/u;

/** Whether a qualified model id names an on-device engine. */
export function isLocalEngineModel(model: string): boolean {
  return LOCAL_ENGINE_MODEL.test(model);
}

/** The request body for `request`, without streaming options. */
export function buildChatCompletionBody<Message = ChatCompletionMessage>(
  request: ChatCompletionBodyInput<Message>,
  options: ChatCompletionBodyOptions = {},
): ChatCompletionBody<Message> {
  // Preserve the evaluated writing policy until effective output budgets have their own A/B gate.
  const maxTokens =
    request.maxTokens ??
    (request.purpose === 'write' && isLocalEngineModel(request.model)
      ? request.contextWindow
      : undefined);
  return {
    model: request.model,
    messages: [...request.messages],
    ...(request.purpose === 'write' ? {} : { reasoning_effort: 'none' as const }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(maxTokens == null ? {} : { max_tokens: maxTokens }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(request.responseFormat
      ? {
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: request.responseFormat.name,
              schema: { ...request.responseFormat.schema },
              strict: true as const,
            },
          },
        }
      : {}),
  };
}
