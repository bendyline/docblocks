/**
 * Map provider failures onto the host-agnostic AI error vocabulary.
 *
 * The renderer never sees a provider's error codes. It sees an `AiErrorCode`
 * and a sentence written for the person using DocBlocks; the provider's own
 * explanation travels in `detail`, which is for logs. That split is what the
 * contract means by "never truncate a provider's own explanation into this":
 * a daemon message is not a user message, and cutting one down to fit is how
 * a half-sentence ends up in a dialog.
 */

import { HOST_WIRE_LIMITS } from '@bendyline/docblocks/host';
import type { AiError, AiErrorCode } from '@bendyline/docblocks/host';

/** Raised by this host's own budgets, never by the provider. */
export class AiHostError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    /** The underlying explanation, for logs. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AiHostError';
  }
}

const USER_MESSAGES: Record<AiErrorCode, string> = {
  'provider-unavailable': 'Gezel is not running. Start Gezel, then try again.',
  'approval-denied': 'The connection was declined in Gezel.',
  'approval-timeout': 'Gezel did not receive an answer in time. Try connecting again.',
  'approval-expired': 'The connection request expired. Try connecting again.',
  'approval-required': 'DocBlocks needs to be connected to Gezel again.',
  'inference-disabled':
    "Connected apps are switched off in Gezel. Turn them on in Gezel's settings to use AI in DocBlocks.",
  'already-connected':
    'Gezel already lists a connection for DocBlocks. Remove it under Connected Apps in Gezel, then connect again.',
  'model-unavailable': 'The selected model is not available in Gezel.',
  'model-download-failed': 'Gezel could not download the model.',
  'runtime-missing': 'AI support is not included in this build of DocBlocks.',
  'workspace-not-registered': 'This workspace is not available to Gezel.',
  unsupported: 'This version of Gezel cannot do that. Update Gezel, then try again.',
  'budget-exceeded': 'Too many AI requests are running. Wait for one to finish, then try again.',
  'rate-limited': 'Gezel is busy. Try again in a moment.',
  timeout: 'Gezel stopped responding.',
  cancelled: 'The request was cancelled.',
  unknown: 'Gezel could not complete the request.',
};

/** Provider codes whose meaning is exact. Anything absent falls back to status. */
const PROVIDER_CODES: ReadonlyMap<string, AiErrorCode> = new Map([
  ['daemon_not_running', 'provider-unavailable'],
  ['tls_cert_unreadable', 'provider-unavailable'],
  ['user_denied', 'approval-denied'],
  ['approval_timeout', 'approval-timeout'],
  ['grant_expired', 'approval-expired'],
  // Raised by the SDK before it would register a new grant when no code
  // handler was supplied — exactly the silent-reconnect case.
  ['verification_code_handler_required', 'approval-required'],
  ['unauthorized', 'approval-required'],
  ['forbidden', 'approval-required'],
  ['already_connected', 'already-connected'],
  ['openai_endpoints_disabled', 'inference-disabled'],
  ['verification_not_supported', 'unsupported'],
  ['tools_not_supported_for_provider', 'unsupported'],
  ['model_not_found', 'model-unavailable'],
  ['gezel_not_found', 'model-unavailable'],
  ['rate_limited', 'rate-limited'],
  ['cancelled', 'cancelled'],
]);

/** Module-resolution failures: the SDK is not present in this build. */
const MISSING_MODULE_CODES: ReadonlySet<string> = new Set([
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
]);

/** Node network failures that mean "nothing is listening". */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function bounded(text: string): string {
  const clean = text.replaceAll('\0', '');
  const limit = HOST_WIRE_LIMITS.messageCharacters;
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

export function aiError(
  code: AiErrorCode,
  message = USER_MESSAGES[code],
  detail?: string,
): AiError {
  return {
    code,
    message: bounded(message),
    ...(detail ? { detail: bounded(detail) } : {}),
  };
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'number' ? field : undefined;
}

function codeFor(error: unknown): AiErrorCode {
  if (error instanceof AiHostError) return error.code;
  const name = readString(error, 'name');
  if (name === 'AbortError') return 'cancelled';

  const code = readString(error, 'code');
  if (code) {
    const mapped = PROVIDER_CODES.get(code);
    if (mapped) return mapped;
    if (code.startsWith('missing_scope:')) return 'approval-required';
    if (MISSING_MODULE_CODES.has(code)) return 'runtime-missing';
    if (UNREACHABLE_CODES.has(code)) return 'provider-unavailable';
  }

  // undici reports a refused connection as `TypeError: fetch failed` with the
  // socket error on `cause`.
  const cause =
    typeof error === 'object' && error !== null ? (error as { cause?: unknown }).cause : undefined;
  const causeCode = readString(cause, 'code');
  if (causeCode && UNREACHABLE_CODES.has(causeCode)) return 'provider-unavailable';

  const status = readNumber(error, 'status');
  if (status === 401 || status === 403) return 'approval-required';
  if (status === 404) return 'model-unavailable';
  if (status === 429) return 'rate-limited';
  if (status === 503) return 'provider-unavailable';
  return 'unknown';
}

/** Translate anything thrown by the provider, the SDK, or this host. */
export function toAiError(error: unknown): AiError {
  const code = codeFor(error);
  if (error instanceof AiHostError) return aiError(code, error.message, error.detail);
  const detail = error instanceof Error ? error.message : undefined;
  return aiError(code, USER_MESSAGES[code], detail);
}
