import { createMobileAi } from './host';
const key = 'docblocks-mobile-ai-v1';
export function installMobileAi() {
  return createMobileAi({
    load: async () => {
      const { GezelRuntime, connect } = await import('@bendyline/gezel-capacitor');
      return { runtime: GezelRuntime, client: connect() };
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
