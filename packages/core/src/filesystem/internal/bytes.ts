/**
 * Byte helpers shared by every filesystem provider.
 *
 * Providers own their stored buffers, so every value that crosses the provider
 * boundary is copied rather than aliased. Keeping one implementation here stops
 * the copy semantics (notably: honouring a view's byteOffset/byteLength instead
 * of its whole backing buffer) from drifting between backends.
 */

/** Copy only the visible bytes of a buffer or view into a fresh ArrayBuffer. */
export function copyBytes(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  const source = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy.buffer as ArrayBuffer;
}

/** Compare the visible bytes of two buffers or views for exact equality. */
export function bytesEqual(
  left: ArrayBuffer | Uint8Array,
  right: ArrayBuffer | Uint8Array,
): boolean {
  const leftBytes = ArrayBuffer.isView(left)
    ? new Uint8Array(left.buffer, left.byteOffset, left.byteLength)
    : new Uint8Array(left);
  const rightBytes = ArrayBuffer.isView(right)
    ? new Uint8Array(right.buffer, right.byteOffset, right.byteLength)
    : new Uint8Array(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  return leftBytes.every((byte, index) => byte === rightBytes[index]);
}
