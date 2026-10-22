import type { GezelApp, ChatMessage } from '@bendyline/gezel-app-sdk';
import { AI_WIRE_LIMITS } from '@bendyline/docblocks/host';
import type {
  AiChatKnowledge,
  AiChatKnowledgeSource,
  AiChatMessage,
  AiKnowledgeAction,
} from '@bendyline/docblocks/host';

type KnowledgeRetrieval = Awaited<ReturnType<GezelApp['knowledge']['retrieve']>>;

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

/** Group cited passages by catalog, in the order Gezel ranked them. */
function knowledgeSources(
  passages: KnowledgeRetrieval['passages'],
  names: ReadonlyMap<string, string> | undefined,
): AiChatKnowledgeSource[] {
  const sources = new Map<string, { name: string; titles: string[] }>();
  for (const passage of passages) {
    let source = sources.get(passage.catalogId);
    if (!source) {
      if (sources.size >= AI_WIRE_LIMITS.knowledgeSources) continue;
      const name = names?.get(passage.catalogId) ?? passage.catalogId;
      source = { name: name.slice(0, 256), titles: [] };
      sources.set(passage.catalogId, source);
    }
    const title = passage.title.trim().slice(0, AI_WIRE_LIMITS.knowledgeTitleCharacters);
    if (
      title &&
      !source.titles.includes(title) &&
      source.titles.length < AI_WIRE_LIMITS.knowledgeTitles
    ) {
      source.titles.push(title);
    }
  }
  return [...sources].map(([catalogId, { name, titles }]) => ({ catalogId, name, titles }));
}

export interface GezelKnowledgeContext {
  readonly messages: ChatMessage[];
  /** Null when no catalog is enabled, or Gezel could not say whether one is. */
  readonly knowledge: AiChatKnowledge | null;
}

const warned = new Set<string>();
export async function withGezelKnowledge(
  app: GezelApp,
  messages: readonly AiChatMessage[],
  signal: AbortSignal,
  contextWindow?: number | null,
  maxTokens?: number,
): Promise<GezelKnowledgeContext> {
  const { withKnowledgeContext } = await import('@bendyline/gezel-app-sdk');
  // The SDK folds passages into the prompt and keeps the retrieval to itself;
  // watch the call it makes to learn what was cited.
  const seen: { retrieval?: KnowledgeRetrieval; unavailable?: boolean } = {};
  const knowledge = app.knowledge as GezelApp['knowledge'] | undefined;
  const client: Pick<GezelApp['knowledge'], 'retrieve'> | null = knowledge
    ? {
        retrieve: async (input, options) => {
          seen.retrieval = await knowledge.retrieve(input, options);
          return seen.retrieval;
        },
      }
    : null;
  const enriched = await withKnowledgeContext(client, messages, {
    signal,
    contextWindow,
    maxOutputTokens: maxTokens,
    maxPromptCharacters: AI_WIRE_LIMITS.promptCharacters,
    maxMessages: AI_WIRE_LIMITS.messageEntries,
    onUnavailable(reason) {
      seen.unavailable = true;
      if (warned.has(reason)) return;
      warned.add(reason);
      console.warn(`[ai] sending AI requests without knowledge passages: ${reason}`);
    },
  });
  // Passages count only once they are in the prompt the model receives.
  const cited = enriched.length > messages.length ? (seen.retrieval?.passages ?? []) : [];
  const snapshot = knowledge
    ? await catalogSnapshot(
        app,
        signal,
        cited.map((passage) => passage.catalogId),
      )
    : null;
  if (cited.length) {
    return {
      messages: enriched,
      knowledge: {
        outcome: 'used',
        sources: knowledgeSources(cited, snapshot?.names),
        evidence: cited.map((passage) => passage.text),
      },
    };
  }
  if (!snapshot?.enabled) return { messages: enriched, knowledge: null };
  return {
    messages: enriched,
    knowledge: { outcome: seen.retrieval && !seen.unavailable ? 'none' : 'skipped' },
  };
}
