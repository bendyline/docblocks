/**
 * What DocBlocks shows when it opens: the document that was open last (the
 * default), or Home. First run is unaffected: a new person always sees the
 * welcome screen.
 *
 * Stored per browser profile, like the other app preferences.
 */

export type LaunchView = 'last-document' | 'home';

const STORAGE_KEY = 'docblocks:launchView';

export function loadLaunchView(): LaunchView {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'home' ? 'home' : 'last-document';
  } catch {
    return 'last-document';
  }
}

export function saveLaunchView(view: LaunchView): void {
  try {
    if (view === 'home') localStorage.setItem(STORAGE_KEY, 'home');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore unavailable storage
  }
}
