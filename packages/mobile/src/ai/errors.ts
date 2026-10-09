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
  const sdkCode =
    value && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
      ? value.code
      : '';
  return { code: codes[sdkCode] ?? 'provider-unavailable', message };
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
