/**
 * Inline proofing preferences — which squiggles the editor draws.
 *
 * Two independent switches rather than one, because they fail
 * differently: spell checking is language-agnostic enough to leave on
 * everywhere, while the grammar rules harper ships are English-only and
 * are noise in a document written in anything else. The engine itself is
 * still all-or-nothing (harper lints once and reports a category per
 * finding), so these filter what surfaces; turning both off is what
 * turns proofing — and the ~30 MiB engine download — off entirely.
 *
 * Stored per browser/profile, never in the document: a reader's tolerance
 * for green underlines is not content. The per-document opt-out lives in
 * `squisq-proofing` frontmatter and is separate from this.
 */

export interface ProofingPreferences {
  /** Draw red squiggles under misspellings. */
  spelling: boolean;
  /** Draw green/blue squiggles under grammar and style findings. */
  grammar: boolean;
}

export const DEFAULT_PROOFING_PREFERENCES: Readonly<ProofingPreferences> = {
  spelling: true,
  grammar: true,
};

const STORAGE_KEY = 'docblocks:proofingPreferences';

export function loadProofingPreferences(): ProofingPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PROOFING_PREFERENCES };

    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== 'object' || stored === null) {
      return { ...DEFAULT_PROOFING_PREFERENCES };
    }
    const record = stored as Record<string, unknown>;
    return {
      spelling:
        typeof record.spelling === 'boolean'
          ? record.spelling
          : DEFAULT_PROOFING_PREFERENCES.spelling,
      grammar:
        typeof record.grammar === 'boolean' ? record.grammar : DEFAULT_PROOFING_PREFERENCES.grammar,
    };
  } catch {
    // ignore unavailable storage / malformed JSON
  }
  return { ...DEFAULT_PROOFING_PREFERENCES };
}

export function saveProofingPreferences(value: ProofingPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // ignore quota errors
  }
}
