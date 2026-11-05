import type { AiError, AiErrorCode, AiResult } from '@bendyline/docblocks/host';
export class MobileAiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export function aiError(value: unknown): AiError {
  if (value instanceof MobileAiError) return { code: value.code, message: value.message };
  const message =
    value instanceof Error
      ? value.message.length <= 2000
        ? value.message
        : 'The on-device runtime returned an invalid response.'
      : 'The on-device AI request failed.';
  const codes: Record<string, AiErrorCode> = {
    disabled: 'inference-disabled',
    suspended: 'cancelled',
    aborted: 'cancelled',
    busy: 'rate-limited',
    timeout: 'timeout',
    model_download_failed: 'model-download-failed',
    download_paused: 'cancelled',
    model_not_ready: 'model-unavailable',
    model_unavailable: 'model-unavailable',
    response_too_large: 'budget-exceeded',
    model_download_required: 'model-unavailable',
    insufficient_memory: 'model-unavailable',
  };
  return { code: codes[sdkCode(value)] ?? 'provider-unavailable', message };
}
function sdkCode(value: unknown): string {
  return value && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
    ? value.code
    : '';
}
// Gezel's own deterministic download failures; resuming repeats them, and a
// failed checksum discards the saved bytes. OS network errors vary by platform
// and locale, so every other failure counts as an interruption.
const permanentDownload =
  /SHA-256|resume identity|length differs|expected (model )?length|Compressed model|staging|partial changed|disappeared|HTTP 4(?!08|29)\d\d/;
/** A download the native layer saved for resuming: a dropped connection, or an attempt's time budget. */
export function interruptedDownload(error: unknown): boolean {
  const code = sdkCode(error);
  if (code === 'timeout') return true;
  return (
    code === 'model_download_failed' &&
    !permanentDownload.test(error instanceof Error ? error.message : '')
  );
}
/** Plain-language download failure; the native message stays in `detail` for diagnostics. */
export function downloadFailure(error: unknown): AiError {
  const problem = aiError(error);
  if (problem.code === 'cancelled' || problem.code === 'inference-disabled') return problem;
  const code = sdkCode(error);
  if (code !== 'model_download_failed' && code !== 'timeout') return problem;
  const message = interruptedDownload(error)
    ? 'The download was interrupted. Check your connection, then choose Download model to continue where it stopped.'
    : /SHA-256/.test(problem.message)
      ? 'The downloaded model was damaged, so it was not installed. Choose Download model to try again.'
      : 'The model could not be downloaded. Try again later.';
  return { code: 'model-download-failed', message, detail: problem.message };
}
export function failure<T>(error: unknown): AiResult<T> {
  return { ok: false, error: aiError(error) };
}
export function checkCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new MobileAiError('cancelled', 'The operation was cancelled.');
}
/** A UI subscriber must not break native cleanup or prevent a terminal result. */
export function notify<T>(listener: ((value: T) => void) | undefined, value: T) {
  try {
    listener?.(value);
  } catch {
    /* The operation still owns its lifecycle. */
  }
}
