/**
 * The app-level proofing dictionary — words the user accepted through
 * "Add to dictionary" that should stay accepted everywhere on this device.
 *
 * This is deliberately separate from a document's own
 * `squisq-proof-dictionary` frontmatter, which travels with the file. A name
 * the user writes in every document belongs here; a term specific to one
 * document belongs in that document.
 *
 * Surfaces without durable web storage (the VS Code webview uses the host's
 * state API rather than `localStorage`) pass no store, and only the per-document
 * frontmatter dictionary applies.
 */

/** Where accepted words are remembered between sessions. */
export interface ProofingDictionaryStore {
  /** Every accepted word, in no particular order. */
  read(): readonly string[];
  /** Remember one more accepted word. Duplicates are harmless. */
  append(word: string): void;
}

const STORAGE_KEY = 'docblocks:proofingDictionary';

function readWords(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((word): word is string => typeof word === 'string');
  } catch {
    // Malformed JSON, private mode, or storage denied — start empty rather
    // than failing the editor over a spelling preference.
    return [];
  }
}

/**
 * Browser-local app dictionary, shared by every workspace on this device.
 *
 * Used by the site and by the Electron renderer, whose `app://` origin keeps
 * `localStorage` stable across launches and updates.
 */
export function createLocalProofingDictionary(): ProofingDictionaryStore {
  return {
    read: readWords,
    append(word: string): void {
      try {
        const words = new Set(readWords());
        words.add(word);
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...words]));
      } catch {
        // Quota or storage denied — the word still applies for this session.
      }
    },
  };
}
