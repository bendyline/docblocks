import { AI_WIRE_LIMITS, type AiChatRequest, type AiModelInfo } from '@bendyline/docblocks/host';

export interface DraftCapacityNotice {
  readonly message: string;
  readonly blocked: boolean;
}

// The host currently exposes context size, not a tokenizer. Keep this visibly
// approximate and advisory: scripts, tables, and different languages vary.
function estimateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / 3);
}

export function draftCapacityNotice(
  request: AiChatRequest,
  model: AiModelInfo | null | undefined,
  expectedOutput = '',
): DraftCapacityNotice | null {
  const characters = request.messages.reduce((sum, message) => sum + message.content.length, 0);
  if (characters > AI_WIRE_LIMITS.promptCharacters) {
    return {
      blocked: true,
      message:
        'The source and draft together exceed the request size this app can send. Your draft is preserved. Work on a smaller section, or copy the draft before closing.',
    };
  }
  const capacity = model?.contextWindow;
  if (!capacity || capacity <= 0) return null;
  const input = request.messages.reduce(
    (sum, message) => sum + estimateTokens(message.content) + 8,
    0,
  );
  // Leave estimated room for thinking and a response. This is a warning
  // threshold, never an output cap or a reason to discard source material.
  const reserve = Math.min(4096, Math.floor(capacity / 4));
  if (input + estimateTokens(expectedOutput) + reserve <= capacity) return null;
  return {
    blocked: false,
    message:
      `This request may exceed ${model.label}'s reported ${capacity.toLocaleString()}-token context. ` +
      'Input, thinking, and the draft share that space. This is a size estimate, not an exact token count; local runtime limits may be smaller. ' +
      'For a complete result, use a smaller selection or choose a model with more context in Settings.',
  };
}
