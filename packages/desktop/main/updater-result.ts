import type { UpdateCheckResult, UpdaterStatus } from '@bendyline/docblocks/host';
import { HOST_WIRE_LIMITS } from '@bendyline/docblocks/host';

export type UpdaterActivity = 'idle' | 'checking' | 'downloading';

const RELEASE_URL_BASE = 'https://github.com/bendyline/docblocks/releases/tag';

/**
 * Desktop releases are tagged `desktop-v<version>`, not `v<version>` — the repo
 * also carries `@bendyline/...@<version>` package tags from multi-semantic-release,
 * so the desktop prefix is what disambiguates them. This must stay in step with
 * `.github/workflows/desktop-release.yml` (its `on.push.tags` filter, the
 * `EXPECTED_TAG` guard, and the `tag_name` it passes to the release action).
 * Getting it wrong is silent: the URL is only ever opened in a browser, so a bad
 * prefix surfaces as a 404 behind the update banner's "What's new" button.
 */
export function releaseUrlFor(version: string): string {
  return `${RELEASE_URL_BASE}/desktop-v${version}`;
}

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
