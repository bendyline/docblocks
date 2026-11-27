/**
 * Whether workspace search also ranks by meaning, on a host that ships an
 * embedding model. On by default: the model is in the app and runs on this
 * device. Off pauses embedding and meaning-ranked queries; vectors already
 * stored are kept, so switching back on resumes where it stopped.
 *
 * Stored per browser profile, like the other app preferences.
 */

const STORAGE_KEY = 'docblocks:semanticSearch';

export function loadSemanticSearchEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function saveSemanticSearchEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // ignore unavailable storage
  }
}
