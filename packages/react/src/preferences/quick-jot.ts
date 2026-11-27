/**
 * Whether Quick Jot shows at the bottom of the left pane. On by default; turned
 * off by someone who wants the room for the file list.
 *
 * Stored per browser profile, like the other app preferences, and only when
 * it is off.
 */

const STORAGE_KEY = 'docblocks:quickJot';

export function loadQuickJotVisible(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'hidden';
  } catch {
    return true;
  }
}

export function saveQuickJotVisible(visible: boolean): void {
  try {
    if (visible) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, 'hidden');
  } catch {
    // ignore unavailable storage
  }
}
