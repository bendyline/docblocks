import type { MobileKnowledge } from '@bendyline/gezel-capacitor';
import { gezelKnowledgeUrls } from 'virtual:docblocks-gezel-knowledge';
import { createMobileAi } from './host';
const key = 'docblocks-mobile-ai-v1';
const knowledgeKey = 'docblocks-mobile-knowledge-disabled-v1';

const readList = (name: string): string[] => {
  try {
    const value = JSON.parse(localStorage.getItem(name) ?? '[]') as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
};

export function installMobileAi() {
  // One catalog store for the app's life; reconnecting reuses it.
  let knowledge: MobileKnowledge | undefined;
  return createMobileAi({
    load: async () => {
      const { GezelRuntime, connectEmbeddingRuntime, createMobileKnowledge } =
        await import('@bendyline/gezel-capacitor');
      const catalogs = (knowledge ??= createMobileKnowledge({
        ...gezelKnowledgeUrls,
        readDisabled: () => readList(knowledgeKey),
        writeDisabled: (ids) => localStorage.setItem(knowledgeKey, JSON.stringify(ids)),
      }));
      const connection = connectEmbeddingRuntime(GezelRuntime);
      return {
        ...connection,
        knowledge: catalogs,
        // Suspending AI also stops the catalog worker; the next search starts it.
        close: async () => {
          catalogs.release();
          await connection.close();
        },
      };
    },
    readPreferences: () => {
      const saved = localStorage.getItem(key);
      if (!saved) return null;
      try {
        return JSON.parse(saved) as unknown;
      } catch {
        return null;
      }
    },
    writePreferences: (preferences) => localStorage.setItem(key, JSON.stringify(preferences)),
  });
}
