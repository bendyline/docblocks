import { HOST_WIRE_LIMITS, isBoundedBytePayload } from '@bendyline/docblocks/host';

/**
 * Minimal structural view of Node's `Buffer` constructor.
 *
 * Declared locally rather than imported from `@types/node` because this module
 * is type-checked by the webview's DOM-only tsconfig as well as the extension's.
 */
interface NodeBufferConstructorLike {
  /** Zero-copy view over existing bytes; used read-only to produce base64. */
  from(
    buffer: ArrayBufferLike,
    byteOffset: number,
    length: number,
  ): { toString(encoding: 'base64'): string };
  /** Decodes base64 into a Buffer, which is itself a Uint8Array. */
  from(value: string, encoding: 'base64'): Uint8Array;
}

/**
 * Node's `Buffer`, but only when the bundle actually runs on Node.
 *
 * This is deliberately a runtime lookup on `globalThis` instead of
 * `import { Buffer } from 'node:buffer'`. This module is bundled into three
 * targets — the Node extension host, the web extension host (vscode.dev), and
 * the webview — and a static import would make the bundler inline a Buffer
 * polyfill into (or fail) the two browser targets. Reading `globalThis` keeps
 * the browser bundles free of Node shims: `Buffer` is simply absent there and
 * they take the portable path below.
 *
 * Looked up per call, not at module load, so tests can exercise both paths.
 */
function getNodeBuffer(): NodeBufferConstructorLike | undefined {
  const candidate = (globalThis as { Buffer?: unknown }).Buffer;
  if (typeof candidate !== 'function') return undefined;
  const from = (candidate as { from?: unknown }).from;
  if (typeof from !== 'function') return undefined;
  return candidate as unknown as NodeBufferConstructorLike;
}

/**
 * Portable base64 encode. Chunked so the argument list handed to
 * `String.fromCharCode` stays well inside engine limits.
 *
 * @internal Exported for the equivalence tests that guard the fast path.
 */
export function encodeBase64Portable(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return globalThis.btoa(binary);
}

/**
 * Node fast-path base64 encode — ~160x faster than the portable loop on large
 * payloads, with byte-identical output (see wire-payload-base64.test.ts).
 *
 * The `Buffer.from(buffer, byteOffset, length)` overload is a zero-copy view,
 * so a 100 MB payload is not duplicated just to be encoded. The view is only
 * ever read, and only a string escapes, so sharing the caller's memory is safe.
 *
 * @internal Exported for the equivalence tests that guard the fast path.
 */
export function encodeBase64ViaNodeBuffer(
  nodeBuffer: NodeBufferConstructorLike,
  bytes: Uint8Array,
): string {
  return nodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** Enforce the decoded-size bound. Shared so both paths throw identically. */
function assertDecodedLength(length: number, maximumBytes: number): void {
  if (length > maximumBytes) {
    throw new Error('The decoded payload exceeds the allowed size');
  }
}

/**
 * Portable base64 decode. The bound is checked before the array is allocated,
 * so an oversized payload is rejected without reserving room for it.
 *
 * @internal Exported for the equivalence tests that guard the fast path.
 */
export function decodeBase64Portable(value: string, maximumBytes: number): Uint8Array {
  let binary: string;
  try {
    binary = globalThis.atob(value);
  } catch {
    throw new Error('The encoded payload is malformed');
  }
  assertDecodedLength(binary.length, maximumBytes);

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Node fast-path base64 decode.
 *
 * Two correctness details, both load-bearing and both covered by tests:
 *
 * 1. Only canonical `length % 4 === 0` input may take this path. `Buffer` is
 *    forgiving where `atob` is strict: it silently accepts mispadded strings
 *    such as `"QQ="` and `"=="` that `atob` — and therefore this module's
 *    contract — rejects. Restricted to `length % 4 === 0` the two agree
 *    exactly; the caller sends everything else to the portable path so the
 *    malformed-input contract is preserved unchanged.
 * 2. The result is copied. `Buffer.from(value, 'base64')` may return a view
 *    into Node's shared 64 KB allocation pool, whereas the portable path
 *    always returns a dedicated, offset-0 array. Copying keeps the ownership
 *    semantics identical and prevents a pooled `.buffer` — containing
 *    unrelated data — from escaping to callers that read `.buffer`.
 *
 * @internal Exported for the equivalence tests that guard the fast path.
 */
export function decodeBase64ViaNodeBuffer(
  nodeBuffer: NodeBufferConstructorLike,
  value: string,
  maximumBytes: number,
): Uint8Array {
  const decoded = nodeBuffer.from(value, 'base64');
  assertDecodedLength(decoded.byteLength, maximumBytes);
  return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength).slice();
}

/** True when `value` is canonical enough for `Buffer` and `atob` to agree. */
function canDecodeWithNodeBuffer(value: string): boolean {
  return value.length % 4 === 0;
}

export function decodeBoundedBase64(value: string): Uint8Array {
  if (value.length > HOST_WIRE_LIMITS.base64Characters || value.length % 4 === 1) {
    throw new Error('The encoded payload exceeds the allowed size or is malformed');
  }
  if (value && !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('The encoded payload is malformed');
  }
  const firstPadding = value.indexOf('=');
  if (firstPadding !== -1 && firstPadding < value.length - 2) {
    throw new Error('The encoded payload is malformed');
  }

  const nodeBuffer = getNodeBuffer();
  return nodeBuffer && canDecodeWithNodeBuffer(value)
    ? decodeBase64ViaNodeBuffer(nodeBuffer, value, HOST_WIRE_LIMITS.binaryBytes)
    : decodeBase64Portable(value, HOST_WIRE_LIMITS.binaryBytes);
}

export function encodeBoundedBase64(bytes: Uint8Array): string {
  assertBoundedBytes(bytes);

  const nodeBuffer = getNodeBuffer();
  // `assertBoundedBytes` also admits ArrayBuffer, which the portable loop turns
  // into ''. Require a real Uint8Array before taking the fast path so that
  // quirk cannot diverge between the two implementations.
  const encoded =
    nodeBuffer && bytes instanceof Uint8Array
      ? encodeBase64ViaNodeBuffer(nodeBuffer, bytes)
      : encodeBase64Portable(bytes);

  if (encoded.length > HOST_WIRE_LIMITS.base64Characters) {
    throw new Error('The encoded payload exceeds the allowed size');
  }
  return encoded;
}

export function assertBoundedBytes(bytes: Uint8Array): void {
  if (!isBoundedBytePayload(bytes, HOST_WIRE_LIMITS.binaryBytes)) {
    throw new Error('The payload exceeds the allowed size');
  }
}
