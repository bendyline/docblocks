import type { OpenRequest } from './types.js';

/** Quantitative limits shared by privileged host boundaries. */
export const HOST_WIRE_LIMITS = Object.freeze({
  identifierCharacters: 256,
  labelCharacters: 1_024,
  pathCharacters: 4_096,
  urlCharacters: 8_192,
  messageCharacters: 2_000,
  documentCharacters: 20 * 1024 * 1024,
  binaryBytes: 100 * 1024 * 1024,
  base64Characters: 140 * 1024 * 1024,
  arrayEntries: 10_000,
});

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

export function isBoundedString(
  value: unknown,
  maximumCharacters: number,
  minimumCharacters = 0,
): value is string {
  return (
    typeof value === 'string' &&
    value.length >= minimumCharacters &&
    value.length <= maximumCharacters &&
    !value.includes('\0')
  );
}

export function isBoundedBytePayload(
  value: unknown,
  maximumBytes = HOST_WIRE_LIMITS.binaryBytes,
): value is ArrayBuffer | Uint8Array {
  return (
    (value instanceof ArrayBuffer || value instanceof Uint8Array) &&
    value.byteLength <= maximumBytes
  );
}

/** Parse one exact, bounded main-to-renderer open request. */
export function parseOpenRequest(value: unknown): OpenRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (record.kind === 'workspace-file') {
    if (!hasExactKeys(record, ['kind', 'workspaceId', 'path'])) return null;
    if (!isBoundedString(record.workspaceId, HOST_WIRE_LIMITS.identifierCharacters, 1)) return null;
    if (!isBoundedString(record.path, HOST_WIRE_LIMITS.pathCharacters, 1)) return null;
    return { kind: 'workspace-file', workspaceId: record.workspaceId, path: record.path };
  }

  if (record.kind === 'external-file' || record.kind === 'external-bundle') {
    if (!hasExactKeys(record, ['kind', 'resourceId', 'name'])) return null;
    if (!isBoundedString(record.resourceId, HOST_WIRE_LIMITS.identifierCharacters, 1)) return null;
    if (!isBoundedString(record.name, HOST_WIRE_LIMITS.labelCharacters, 1)) return null;
    return { kind: record.kind, resourceId: record.resourceId, name: record.name };
  }

  return null;
}

/** Return one canonical HTTP(S) URL, or null when external navigation is unsafe. */
export function parseExternalHttpUrl(value: unknown): string | null {
  if (!isBoundedString(value, HOST_WIRE_LIMITS.urlCharacters, 1)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    const canonical = url.href;
    return canonical.length <= HOST_WIRE_LIMITS.urlCharacters ? canonical : null;
  } catch {
    return null;
  }
}

/** True only for the packaged renderer origin or the exact configured dev origin. */
export function isTrustedRendererUrl(value: unknown, developmentOrigin?: string): boolean {
  if (!isBoundedString(value, HOST_WIRE_LIMITS.urlCharacters, 1)) return false;
  try {
    const url = new URL(value);
    if (
      url.protocol === 'app:' &&
      url.hostname === 'docblocks' &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
    ) {
      return true;
    }
    if (!developmentOrigin) return false;
    const trustedDevelopmentOrigin = new URL(developmentOrigin);
    return url.origin === trustedDevelopmentOrigin.origin;
  } catch {
    return false;
  }
}
