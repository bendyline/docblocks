import type { UpdateCheckResult, UpdaterStatus } from '@bendyline/docblocks/host';
import { HOST_WIRE_LIMITS } from '@bendyline/docblocks/host';

export type UpdaterActivity = 'idle' | 'checking' | 'downloading';

const RELEASE_URL_BASE = 'https://github.com/bendyline/docblocks/releases/tag';

const UPDATE_ERROR_MESSAGES = {
  dns: 'DocBlocks couldn\u2019t reach the update server. Check your internet connection, VPN, or DNS settings, then try again.',
  network:
    'DocBlocks couldn\u2019t reach the update server. Check your internet connection and try again.',
  proxy:
    'DocBlocks couldn\u2019t connect through your proxy or VPN. Check those settings and try again.',
  timeout:
    'The update server took too long to respond. Check your internet connection and try again.',
  secureConnection:
    'DocBlocks couldn\u2019t establish a secure connection to the update server. Check your system clock, proxy, or network security settings, then try again.',
  diskSpace: 'DocBlocks needs more free disk space to download the update.',
  fileAccess: 'DocBlocks couldn\u2019t save the update. Check its file permissions and try again.',
  verification:
    'The downloaded update couldn\u2019t be verified, so DocBlocks did not install it. Try again later.',
  service: 'Update information is temporarily unavailable. Try again later.',
  unknown: 'DocBlocks couldn\u2019t complete the update. Try again later.',
} as const;

function updaterErrorSearchText(error: unknown): string {
  if (typeof error === 'string') return error.toUpperCase();
  if (typeof error !== 'object' || error === null) return String(error).toUpperCase();

  const errorRecord: Record<string, unknown> = error as Record<string, unknown>;
  const code = typeof errorRecord.code === 'string' ? errorRecord.code : '';
  const message = typeof errorRecord.message === 'string' ? errorRecord.message : String(error);
  return `${code} ${message}`.toUpperCase();
}

/**
 * Convert Electron, Node, and electron-updater failures into stable copy that
 * helps a user recover without exposing transport internals or release URLs.
 */
export function userFacingUpdaterErrorMessage(error: unknown): string {
  const text = updaterErrorSearchText(error);

  if (/ERR_PROXY_|ERR_TUNNEL_CONNECTION_FAILED|PROXY AUTH/.test(text)) {
    return UPDATE_ERROR_MESSAGES.proxy;
  }
  if (/ERR_NAME_NOT_RESOLVED|ERR_DNS_|ENOTFOUND|EAI_AGAIN|GETADDRINFO|\bDNS\b/.test(text)) {
    return UPDATE_ERROR_MESSAGES.dns;
  }
  if (
    /ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|ESOCKETTIMEDOUT|REQUEST TIMED OUT|GATEWAY TIMEOUT/.test(
      text,
    )
  ) {
    return UPDATE_ERROR_MESSAGES.timeout;
  }
  if (
    /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_|ERR_CONNECTION_(?:REFUSED|RESET|CLOSED|ABORTED)|ERR_ADDRESS_UNREACHABLE|ENETDOWN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ECONNRESET|ECONNABORTED|EPIPE|NETWORK UNREACHABLE|\bOFFLINE\b/.test(
      text,
    )
  ) {
    return UPDATE_ERROR_MESSAGES.network;
  }
  if (/ERR_CERT_|ERR_SSL_|\bCERTIFICATE\b|UNABLE TO VERIFY|\bTLS\b|\bSSL\b/.test(text)) {
    return UPDATE_ERROR_MESSAGES.secureConnection;
  }
  if (/\bENOSPC\b|NO SPACE LEFT|DISK(?: IS)?.+FULL/.test(text)) {
    return UPDATE_ERROR_MESSAGES.diskSpace;
  }
  if (/\b(?:EACCES|EPERM|EROFS)\b|READ-ONLY FILE SYSTEM/.test(text)) {
    return UPDATE_ERROR_MESSAGES.fileAccess;
  }
  if (/ERR_CHECKSUM_MISMATCH|CHECKSUM MISMATCH|ERR_UPDATER_INVALID_SIGNATURE/.test(text)) {
    return UPDATE_ERROR_MESSAGES.verification;
  }
  if (
    /ERR_UPDATER_|ERR_HTTP_RESPONSE_CODE_FAILURE|HTTP ERROR (?:4\d\d|5\d\d)|STATUS CODE (?:4\d\d|5\d\d)|\b(?:404|408|429|500|502|503|504)\b/.test(
      text,
    )
  ) {
    return UPDATE_ERROR_MESSAGES.service;
  }

  return UPDATE_ERROR_MESSAGES.unknown;
}

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
  return {
    kind: 'error',
    message: userFacingUpdaterErrorMessage(error).slice(0, HOST_WIRE_LIMITS.messageCharacters),
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
