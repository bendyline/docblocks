import type { UpdateCheckResult, UpdaterStatus } from '@bendyline/docblocks/host';
import { HOST_WIRE_LIMITS } from '@bendyline/docblocks/host';

export type UpdaterActivity = 'idle' | 'checking' | 'downloading';

export function classifyUpdateCheck(
  currentVersion: string,
  candidateVersion: string | null | undefined,
): UpdateCheckResult {
  return candidateVersion && candidateVersion !== currentVersion
    ? { kind: 'available', version: candidateVersion }
    : { kind: 'not-available' };
}

export function failedUpdateCheck(error: unknown): Extract<UpdateCheckResult, { kind: 'error' }> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: 'error',
    message: (message || 'Update check failed').slice(0, HOST_WIRE_LIMITS.messageCharacters),
  };
}

/**
 * Update checks are opportunistic: a missing release manifest or an offline
 * server should behave like there is no update. Once a download has started,
 * however, failures remain visible so the user is not left with a stuck
 * "downloading" banner.
 */
export function updaterStatusForError(activity: UpdaterActivity, error: unknown): UpdaterStatus {
  return activity === 'checking' ? { kind: 'not-available' } : failedUpdateCheck(error);
}
