import type { UpdateCheckResult } from '@bendyline/docblocks/host';
import { HOST_WIRE_LIMITS } from '@bendyline/docblocks/host';

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
