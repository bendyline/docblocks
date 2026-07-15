/**
 * Normalize an unknown rejection into an Error without losing its text.
 *
 * Every extension-host surface that reports a failure to the user (toasts, the
 * status bar, `saveResult` payloads) needs the same normalization, so it lives
 * here rather than being re-declared per module.
 */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
