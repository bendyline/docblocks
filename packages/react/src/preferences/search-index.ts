/**
 * Per workspace: whether its search index is kept on this device between
 * launches. Kept by default, so search is ready at launch; off, the index is
 * built in memory each session and nothing of it stays on the device.
 *
 * Stored per browser profile, never in the workspace.
 */

const STORAGE_KEY = 'docblocks:keepSearchIndex';

export type SearchIndexChoices = Readonly<Record<string, boolean>>;

export function loadSearchIndexChoices(): SearchIndexChoices {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
      ),
    );
  } catch {
    return {};
  }
}

export function saveSearchIndexChoices(choices: SearchIndexChoices): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // ignore unavailable storage
  }
}

export function keepsSearchIndex(choices: SearchIndexChoices, workspaceId: string | null): boolean {
  return workspaceId === null ? true : (choices[workspaceId] ?? true);
}
