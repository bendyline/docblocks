/**
 * Canonical wire format for a document embedded in a DocBlocks URL hash.
 *
 * The base64 payload is deliberately small and versioned:
 *
 *   "DBSHARE" + version byte + mode byte + bounded DBK bytes
 *
 * The DBK itself is validated at the filesystem import boundary. Keeping the
 * launch mode outside the archive means the copied Markdown is never mutated
 * merely to choose its initial presentation.
 */

export type SharedDocumentMode = 'slideshow' | 'video' | 'page' | 'document' | 'narrate';

export interface SharedDocumentPayload {
  readonly archive: Uint8Array;
  readonly mode: SharedDocumentMode | null;
}

export type SharedDocumentHashParseResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'valid'; readonly payload: SharedDocumentPayload }
  | { readonly kind: 'invalid'; readonly message: string };

export const SHARED_DOCUMENT_LIMITS = Object.freeze({
  /** Conservative ceiling for a locally rendered, medium-correction QR code. */
  qrUrlCharacters: 2_048,
  /** A conservative interoperability threshold, not a universal browser limit. */
  portableUrlCharacters: 4_096,
  /** Hard cap applied before a hash is copied or decoded. */
  urlCharacters: 32_768,
  /** Maximum UTF-8 Markdown accepted by the first-party link generator. */
  markdownBytes: 20 * 1024,
  /** Maximum compressed DBK bytes carried by the versioned envelope. */
  archiveBytes: 23 * 1024,
});

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const HASH_PREFIX = '#shared(';
const MAGIC = new Uint8Array([0x44, 0x42, 0x53, 0x48, 0x41, 0x52, 0x45]); // DBSHARE
const VERSION = 1;
const HEADER_BYTES = MAGIC.byteLength + 2;

const MODE_TO_CODE: Readonly<Record<SharedDocumentMode, number>> = Object.freeze({
  slideshow: 1,
  video: 2,
  page: 3,
  document: 4,
  narrate: 5,
});

const CODE_TO_MODE: Readonly<Record<number, SharedDocumentMode>> = Object.freeze({
  1: 'slideshow',
  2: 'video',
  3: 'page',
  4: 'document',
  5: 'narrate',
});

/** Build the exact `#shared(<base64>)` fragment for a bounded DBK archive. */
export function createSharedDocumentHash(
  archive: Uint8Array,
  mode: SharedDocumentMode | null = null,
): string {
  assertArchive(archive);
  const bytes = new Uint8Array(HEADER_BYTES + archive.byteLength);
  bytes.set(MAGIC, 0);
  bytes[MAGIC.byteLength] = VERSION;
  bytes[MAGIC.byteLength + 1] = mode === null ? 0 : MODE_TO_CODE[mode];
  bytes.set(archive, HEADER_BYTES);

  const hash = `${HASH_PREFIX}${encodeBase64(bytes)})`;
  if (hash.length > SHARED_DOCUMENT_LIMITS.urlCharacters) {
    throw new Error('The shared document payload exceeds the URL length limit.');
  }
  return hash;
}

/** Replace any existing hash on a base URL with a validated shared payload. */
export function createSharedDocumentUrl(
  baseUrl: string,
  archive: Uint8Array,
  mode: SharedDocumentMode | null = null,
): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Shared document links require an HTTP(S) DocBlocks URL.');
  }
  url.hash = createSharedDocumentHash(archive, mode);
  const result = url.toString();
  if (result.length > SHARED_DOCUMENT_LIMITS.urlCharacters) {
    throw new Error('The shared document link exceeds the URL length limit.');
  }
  return result;
}

/** Parse a hash without ever treating malformed shared input as workspace routing. */
export function parseSharedDocumentHash(hash: string): SharedDocumentHashParseResult {
  if (!hash.startsWith('#shared')) return { kind: 'none' };
  if (
    hash.length > SHARED_DOCUMENT_LIMITS.urlCharacters ||
    !hash.startsWith(HASH_PREFIX) ||
    !hash.endsWith(')')
  ) {
    return invalid('This shared document link is malformed or too long.');
  }

  const encoded = hash.slice(HASH_PREFIX.length, -1);
  const maximumPayloadBytes = HEADER_BYTES + SHARED_DOCUMENT_LIMITS.archiveBytes;
  const maximumBase64Characters = Math.ceil(maximumPayloadBytes / 3) * 4;
  if (encoded.length === 0 || encoded.length > maximumBase64Characters) {
    return invalid('This shared document payload is empty or too large.');
  }

  const bytes = decodeBase64(encoded, maximumPayloadBytes);
  if (!bytes || bytes.byteLength <= HEADER_BYTES) {
    return invalid('This shared document payload is not valid base64 data.');
  }
  for (let index = 0; index < MAGIC.byteLength; index += 1) {
    if (bytes[index] !== MAGIC[index]) {
      return invalid('This shared document payload has an unknown format.');
    }
  }
  if (bytes[MAGIC.byteLength] !== VERSION) {
    return invalid('This shared document link uses an unsupported version.');
  }

  const modeCode = bytes[MAGIC.byteLength + 1] ?? 0;
  const mode = modeCode === 0 ? null : CODE_TO_MODE[modeCode];
  if (modeCode !== 0 && !mode) {
    return invalid('This shared document link has an unsupported launch mode.');
  }

  const archive = bytes.slice(HEADER_BYTES);
  if (!hasZipSignature(archive)) {
    return invalid('This shared document payload does not contain a DBK archive.');
  }
  return { kind: 'valid', payload: { archive, mode } };
}

function assertArchive(archive: Uint8Array): void {
  if (archive.byteLength === 0 || archive.byteLength > SHARED_DOCUMENT_LIMITS.archiveBytes) {
    throw new Error('The shared document archive exceeds the URL payload limit.');
  }
  if (!hasZipSignature(archive)) {
    throw new Error('A shared document payload must contain a DBK ZIP archive.');
  }
}

function hasZipSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

function invalid(message: string): SharedDocumentHashParseResult {
  return { kind: 'invalid', message };
}

function encodeBase64(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const first = bytes[index] ?? 0;
    const hasSecond = index + 1 < bytes.byteLength;
    const hasThird = index + 2 < bytes.byteLength;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const value = (first << 16) | (second << 8) | third;
    result += BASE64_ALPHABET[(value >>> 18) & 63];
    result += BASE64_ALPHABET[(value >>> 12) & 63];
    result += hasSecond ? BASE64_ALPHABET[(value >>> 6) & 63] : '=';
    result += hasThird ? BASE64_ALPHABET[value & 63] : '=';
  }
  return result;
}

function decodeBase64(value: string, maximumBytes: number): Uint8Array | null {
  if (
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value) ||
    value.slice(0, -2).includes('=')
  ) {
    return null;
  }

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const byteLength = (value.length / 4) * 3 - padding;
  if (byteLength <= 0 || byteLength > maximumBytes) return null;

  const result = new Uint8Array(byteLength);
  let outputIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = BASE64_ALPHABET.indexOf(value[index] ?? '');
    const b = BASE64_ALPHABET.indexOf(value[index + 1] ?? '');
    const c = value[index + 2] === '=' ? 0 : BASE64_ALPHABET.indexOf(value[index + 2] ?? '');
    const d = value[index + 3] === '=' ? 0 : BASE64_ALPHABET.indexOf(value[index + 3] ?? '');
    if (a < 0 || b < 0 || c < 0 || d < 0) return null;
    const combined = (a << 18) | (b << 12) | (c << 6) | d;
    if (outputIndex < byteLength) result[outputIndex++] = (combined >>> 16) & 0xff;
    if (outputIndex < byteLength) result[outputIndex++] = (combined >>> 8) & 0xff;
    if (outputIndex < byteLength) result[outputIndex++] = combined & 0xff;
  }

  // Reject non-canonical encodings with non-zero unused bits.
  return encodeBase64(result) === value ? result : null;
}
