import type { GezelApp, ChatMessage } from '@bendyline/gezel-app-sdk';
import { AI_WIRE_LIMITS } from '@bendyline/docblocks/host';
import type { AiChatMessage, AiKnowledgeAction } from '@bendyline/docblocks/host';

/** Project the SDK's catalog state into the provider-neutral renderer contract. */
export async function gezelKnowledgeState(app: GezelApp, signal: AbortSignal): Promise<unknown> {
  const { catalogs, improvement } = await app.knowledge.state({ signal });
  return {
    catalogs,
    improvement: improvement
      ? { downloadBytes: improvement.downloadBytes, downloading: improvement.downloading }
      : null,
  };
}
export function updateGezelKnowledge(
  app: GezelApp,
  action: AiKnowledgeAction,
  signal: AbortSignal,
): Promise<void> {
  return app.knowledge.update(
    action.action === 'improve' ? { action: 'prepare-reranker' } : action,
    { signal },
  );
}

const warned = new Set<string>();
export async function withGezelKnowledge(
  app: GezelApp,
  messages: readonly AiChatMessage[],
  signal: AbortSignal,
  contextWindow?: number | null,
  maxTokens?: number,
): Promise<ChatMessage[]> {
  const { withKnowledgeContext } = await import('@bendyline/gezel-app-sdk');
  return withKnowledgeContext(app.knowledge, messages, {
    signal,
    contextWindow,
    maxOutputTokens: maxTokens,
    maxPromptCharacters: AI_WIRE_LIMITS.promptCharacters,
    maxMessages: AI_WIRE_LIMITS.messageEntries,
    onUnavailable(reason) {
      if (warned.has(reason)) return;
      warned.add(reason);
      console.warn(`[ai] sending AI requests without knowledge passages: ${reason}`);
    },
  });
}
