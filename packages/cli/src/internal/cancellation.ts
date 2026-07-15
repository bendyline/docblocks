/**
 * Cancellation helpers shared by the CLI commands and the MCP services.
 *
 * A caller-supplied abort reason is always preserved so cancellation stays
 * attributable. When a signal aborts without a usable reason, a synthesized
 * `AbortError` carrying the operation-specific `message` is thrown instead —
 * every caller therefore receives an `Error`, never a bare `null`.
 */
export function cancellationError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? cancellationError(message);
}
