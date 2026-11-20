import type { AiWorkspacePassage } from './ai.js';

/** The catalog id workspace passages report, and the name sources show for it. */
export const WORKSPACE_KNOWLEDGE_CATALOG_ID = 'workspace';
export const WORKSPACE_KNOWLEDGE_NAME = 'This workspace';
const WORKSPACE_KNOWLEDGE_VERSION = 'local';

/** One retrieved passage, in the shape Gezel's knowledge client returns. */
export interface KnowledgeRetrievedPassage {
  readonly uri: string;
  readonly title: string;
  readonly text: string;
  readonly catalogId: string;
  readonly version: string;
}

/** Structurally Gezel's `KnowledgeClient['retrieve']`, without importing Gezel. */
export interface KnowledgeRetriever {
  retrieve(
    query: { readonly query: string; readonly maxResults: number; readonly maxCharacters: number },
    options?: { readonly signal?: AbortSignal },
  ): Promise<{
    readonly reranked: boolean;
    readonly passages: readonly KnowledgeRetrievedPassage[];
  }>;
}

/**
 * A knowledge client whose retrievals also offer the request's workspace
 * passages, so Gezel's `knowledgeContext` puts both under one budget and one
 * citation numbering. Catalog passages and workspace passages alternate,
 * catalogs first, until `maxResults`; a passage that would overrun
 * `maxCharacters` is skipped. A failing catalog search still leaves the
 * workspace passages (knowledge never blocks a request); cancellation does
 * not.
 *
 * The workspace passages were admitted by the index already: found by
 * meaning above the embedding profile's measured floor, the bar Gezel holds
 * unjudged catalog passages to.
 */
export function withWorkspacePassages<C extends KnowledgeRetriever>(
  client: C | null | undefined,
  passages: readonly AiWorkspacePassage[] | undefined,
): KnowledgeRetriever | C | null {
  if (!passages?.length) return client ?? null;
  const local: KnowledgeRetrievedPassage[] = passages.map((passage) => ({
    ...passage,
    catalogId: WORKSPACE_KNOWLEDGE_CATALOG_ID,
    version: WORKSPACE_KNOWLEDGE_VERSION,
  }));
  return {
    async retrieve(query, options) {
      let curated: readonly KnowledgeRetrievedPassage[] = [];
      let reranked = false;
      if (client) {
        try {
          const result = await client.retrieve(query, options);
          curated = result.passages;
          reranked = result.reranked;
        } catch (error: unknown) {
          if (options?.signal?.aborted) throw error;
        }
      }
      options?.signal?.throwIfAborted();
      const merged: KnowledgeRetrievedPassage[] = [];
      let characters = 0;
      const offer = (passage: KnowledgeRetrievedPassage | undefined) => {
        if (!passage || merged.length >= query.maxResults) return;
        if (characters + passage.text.length > query.maxCharacters) return;
        merged.push(passage);
        characters += passage.text.length;
      };
      for (let i = 0; i < Math.max(curated.length, local.length); i += 1) {
        offer(curated[i]);
        offer(local[i]);
      }
      return { reranked, passages: merged };
    },
  };
}
