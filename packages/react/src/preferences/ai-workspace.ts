/**
 * Per workspace: whether AI answers may draw on the workspace's notes.
 * Unchosen, it follows the provider: on when the model runs on this device,
 * off for a remote provider, whose requests would carry the passages away.
 *
 * Stored per browser profile, never in the workspace.
 */

const STORAGE_KEY = 'docblocks:aiWorkspaceGrounding';

export type WorkspaceGroundingChoices = Readonly<Record<string, boolean>>;

export function loadWorkspaceGroundingChoices(): WorkspaceGroundingChoices {
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

export function saveWorkspaceGroundingChoices(choices: WorkspaceGroundingChoices): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // ignore unavailable storage
  }
}

export function workspaceGroundingEnabled(
  choices: WorkspaceGroundingChoices,
  workspaceId: string | null,
  providerRemote: boolean,
): boolean {
  if (!workspaceId) return false;
  return choices[workspaceId] ?? !providerRemote;
}
