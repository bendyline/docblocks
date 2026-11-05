import { kokoroLexiconUrls } from 'virtual:docblocks-kokoro-lexicon';
import { createMobileSpeechHost } from './host';
const key = 'docblocks-mobile-speech-v1';

/** Gzipped dictionaries arrive as web assets and are inflated once, on first narration. */
async function lexicon(language: 'us' | 'gb'): Promise<string> {
  const response = await fetch(kokoroLexiconUrls[language]);
  if (!response.ok || !response.body) throw new Error(`Missing ${language} dictionary`);
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text();
}

export function installMobileSpeech() {
  return createMobileSpeechHost({
    load: async () => {
      const { createMobileSpeech } = await import('@bendyline/gezel-capacitor');
      return createMobileSpeech({ lexicon });
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
