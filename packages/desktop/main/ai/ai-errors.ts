/**
 * Map provider failures onto the host-agnostic AI error vocabulary.
 *
 * The renderer never sees a provider's error codes. It sees an `AiErrorCode`
 * and a sentence written for the person using DocBlocks; the provider's own
 * explanation travels in `detail`, which is for logs. That split is what the
 * contract means by "never truncate a provider's own explanation into this":
 * a daemon message is not a user message, and cutting one down to fit is how
 * a half-sentence ends up in a dialog.
 *
 * The one exception is a failure nothing here recognizes. Its sentence alone
 * says nothing a person could report, so it carries a short, labeled clue —
 * the provider's code when there is one — while `detail` keeps the whole text.
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
  unknown: 'AI Services (Gezel) could not complete this request.',
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
  ['model_download_required', 'model-unavailable'],
  ['model_not_ready', 'model-unavailable'],
  ['model_unavailable', 'model-unavailable'],
  ['system_model_unavailable', 'model-unavailable'],
  ['model_download_failed', 'model-download-failed'],
  ['engine_download_failed', 'model-download-failed'],
  ['service_not_installed', 'runtime-missing'],
  ['service_inference_only_unsupported', 'runtime-missing'],
  ['native_payload_required', 'runtime-missing'],
  ['native_verification_unavailable', 'runtime-missing'],
  ['native_verification_failed', 'runtime-missing'],
  ['unsupported_option', 'unsupported'],
  ['aborted', 'cancelled'],
  ['busy', 'rate-limited'],
  ['gezel_not_found', 'model-unavailable'],
  ['rate_limited', 'rate-limited'],
  ['cancelled', 'cancelled'],
  ['reranker_required', 'model-unavailable'],
  ['reranker_unavailable', 'model-unavailable'],
  ['knowledge_unavailable', 'unsupported'],
  // Gezel's on-device engine failures. Before Gezel named them, every one
  // arrived as `provider_error`. A crash is deliberately not
  // provider-unavailable: that would tear down a connection that still works.
  ['capacity_denied', 'model-unavailable'],
  ['engine_busy', 'rate-limited'],
  ['engine_launch_failed', 'runtime-missing'],
  ['engine_crashed', 'unknown'],
  ['context_length_exceeded', 'budget-exceeded'],
  ['engine_not_ready', 'model-unavailable'],
]);

/** Provider codes that say more than their category's sentence does. */
const PROVIDER_SENTENCES: ReadonlyMap<string, string> = new Map([
  [
    'capacity_denied',
    'This computer does not have enough free memory to run this model. Close other apps, or choose a smaller model in Settings.',
  ],
  ['engine_busy', 'The AI model is busy with another request. Try again in a moment.'],
  ['engine_launch_failed', 'The on-device AI engine could not start on this computer.'],
  ['engine_crashed', 'The AI model stopped unexpectedly. Try again.'],
  [
    'context_length_exceeded',
    'This is more text than the selected model can read at once. Select less text, or choose a model that can read more.',
  ],
  ['engine_not_ready', 'The on-device AI engine is still getting ready. Try again in a moment.'],
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

/** How much of an unrecognized failure the dialog shows: enough to quote, not to read. */
const DIAGNOSTIC_CHARACTERS = 40;

/** Catch-all provider codes, which say less than the message they carry. */
const GENERIC_PROVIDER_CODES: ReadonlySet<string> = new Set(['provider_error', 'internal_error']);

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

/**
 * A short clue for a failure `codeFor` could not classify: the provider's (or
 * the socket's) code first, since that is exact, then as much of its message
 * as fits — unless the code is a catch-all, when the message is the clue.
 */
function diagnosticFor(error: unknown): string | null {
  const cause =
    typeof error === 'object' && error !== null ? (error as { cause?: unknown }).cause : undefined;
  const status = readNumber(error, 'status');
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const text = raw.replaceAll('\0', '').replace(/\s+/gu, ' ').trim();
  let label = readString(error, 'code') ?? readString(cause, 'code');
  if (label === undefined && status !== undefined) label = `HTTP ${status}`;
  // Gezel wraps every engine failure (out of memory, crash, startup timeout)
  // as `provider_error`; the reason is in the message, so give it the room.
  if (label && text && GENERIC_PROVIDER_CODES.has(label)) label = undefined;
  const clue = label && !text.startsWith(label) ? [label, text].filter(Boolean).join(': ') : text;
  if (!clue) return null;
  return clue.length <= DIAGNOSTIC_CHARACTERS
    ? clue
    : `${clue.slice(0, DIAGNOSTIC_CHARACTERS - 1).trimEnd()}…`;
}

/** Translate anything thrown by the provider, the SDK, or this host. */
export function toAiError(error: unknown): AiError {
  const code = codeFor(error);
  if (error instanceof AiHostError) return aiError(code, error.message, error.detail);
  if (
    readString(error, 'code') === 'reranker_required' ||
    readString(error, 'code') === 'reranker_unavailable'
  ) {
    return aiError(
      'model-unavailable',
      // Retrieval never needs the model, so only the improvement download lands
      // here. People hear "better knowledge results", never "reranker".
      'Gezel could not download the model that improves knowledge results.',
      error instanceof Error ? error.message : undefined,
    );
  }
  const detail = error instanceof Error ? error.message : undefined;
  const sentence = PROVIDER_SENTENCES.get(readString(error, 'code') ?? '');
  if (sentence) return aiError(code, sentence, detail);
  if (code === 'unknown') {
    const clue = diagnosticFor(error);
    const message = clue ? `${USER_MESSAGES.unknown} (Details: ${clue})` : USER_MESSAGES.unknown;
    return aiError(code, message, detail);
  }
  return aiError(code, USER_MESSAGES[code], detail);
}
