/**
 * Structural guard shared by the filesystem providers that validate untrusted
 * payloads — stored IndexedDB records and Electron transport messages.
 */

/** True for any non-null object, including arrays and class instances. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
