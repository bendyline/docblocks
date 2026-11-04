import type { GezelApp, ChatMessage } from '@bendyline/gezel-app-sdk';
import { AI_WIRE_LIMITS, knowledgeChatEvent } from '@bendyline/docblocks/host';
import type { AiChatKnowledge, AiChatMessage, AiKnowledgeAction } from '@bendyline/docblocks/host';

interface CatalogSnapshot {
  readonly at: number;
  readonly names: ReadonlyMap<string, string>;
  readonly enabled: boolean;
}

/**
 * Catalog names and whether any is enabled, for labelling requests. Gezel
 * serves at most four knowledge requests at once, so a chat reads this at
 * most once per interval rather than once per request.
 */
const CATALOG_SNAPSHOT_MS = 30_000;
const CATALOG_STATE_TIMEOUT_MS = 2_000;
const catalogSnapshots = new WeakMap<GezelApp, CatalogSnapshot>();

function rememberCatalogs(app: GezelApp, catalogs: readonly unknown[]): CatalogSnapshot {
  const names = new Map<string, string>();
  let enabled = false;
  for (const catalog of catalogs) {
    if (typeof catalog !== 'object' || catalog === null) continue;
    const { id, name } = catalog as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || !id) continue;
    names.set(id, typeof name === 'string' && name ? name : id);
    if ((catalog as { enabled?: unknown }).enabled === true) enabled = true;
  }
  const snapshot = { at: Date.now(), names, enabled };
  catalogSnapshots.set(app, snapshot);
  return snapshot;
}

async function catalogSnapshot(
  app: GezelApp,
  signal: AbortSignal,
  needed: readonly string[],
): Promise<CatalogSnapshot | null> {
  const cached = catalogSnapshots.get(app);
  if (
    cached &&
    Date.now() - cached.at < CATALOG_SNAPSHOT_MS &&
    needed.every((id) => cached.names.has(id))
  ) {
    return cached;
  }
  try {
    const { catalogs } = await app.knowledge.state({
      signal: AbortSignal.any([signal, AbortSignal.timeout(CATALOG_STATE_TIMEOUT_MS)]),
    });
    return rememberCatalogs(app, catalogs);
  } catch {
    signal.throwIfAborted();
    // A label is never worth failing or stalling the request over.
    return cached ?? null;
  }
}

/** Project the SDK's catalog state into the provider-neutral renderer contract. */
export async function gezelKnowledgeState(app: GezelApp, signal: AbortSignal): Promise<unknown> {
  const { catalogs, improvement } = await app.knowledge.state({ signal });
  rememberCatalogs(app, catalogs);
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
  // Enabling or disabling changes what the next request may cite.
  catalogSnapshots.delete(app);
  return app.knowledge.update(
    action.action === 'improve' ? { action: 'prepare-reranker' } : action,
    { signal },
  );
}

export interface GezelKnowledgeContext {
  readonly messages: ChatMessage[];
  /** Null when no catalog is enabled, or Gezel could not say whether one is. */
  readonly knowledge: AiChatKnowledge | null;
}

export interface GezelKnowledgeOptions {
  readonly contextWindow?: number | null;
  readonly maxTokens?: number;
  /** What to search for; the SDK otherwise searches with the last user message. */
  readonly query?: string;
  /** Number the passages and ask for `[n]` citations of them. */
  readonly citations?: boolean;
}

const warned = new Set<string>();
export async function withGezelKnowledge(
  app: GezelApp,
  messages: readonly AiChatMessage[],
  signal: AbortSignal,
  options: GezelKnowledgeOptions = {},
): Promise<GezelKnowledgeContext> {
  const { knowledgeContext } = await import('@bendyline/gezel-app-sdk');
  const knowledge = app.knowledge as GezelApp['knowledge'] | undefined;
  const context = await knowledgeContext(knowledge, messages, {
    signal,
    contextWindow: options.contextWindow,
    maxOutputTokens: options.maxTokens,
    maxPromptCharacters: AI_WIRE_LIMITS.promptCharacters,
    maxMessages: AI_WIRE_LIMITS.messageEntries,
    // Numbered when the caller checks citations: each sentence then says which
    // passage it rests on, and is checked against exactly that passage.
    ...(options.citations ? { citations: 'numbered' as const } : {}),
    ...(options.query?.trim() ? { query: options.query } : {}),
    onUnavailable(reason) {
      if (warned.has(reason)) return;
      warned.add(reason);
      console.warn(`[ai] sending AI requests without knowledge passages: ${reason}`);
    },
  });
  const cited = context.passages;
  const snapshot = knowledge
    ? await catalogSnapshot(
        app,
        signal,
        cited.map((passage) => passage.catalogId),
      )
    : null;
  return {
    messages: context.messages,
    knowledge: knowledgeChatEvent(
      context.status,
      cited,
      snapshot?.names,
      context.status === 'used' || snapshot?.enabled === true,
    ),
  };
}
