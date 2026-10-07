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
  return { code: 'provider-unavailable', message };
}
export function failure<T>(error: unknown): AiResult<T> {
  return { ok: false, error: aiError(error) };
}
export function checkCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new MobileAiError('cancelled', 'The operation was cancelled.');
}
export async function delay(signal: AbortSignal, ms: number) {
  checkCancelled(signal);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new MobileAiError('cancelled', 'The operation was cancelled.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
/** A UI subscriber must not break native cleanup or prevent a terminal result. */
export function notify<T>(listener: ((value: T) => void) | undefined, value: T) {
  try {
    listener?.(value);
  } catch {
    /* The operation still owns its lifecycle. */
  }
}
