import { HOST_WIRE_LIMITS, isBoundedBytePayload } from '@bendyline/docblocks/host';

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

  let binary: string;
  try {
    binary = globalThis.atob(value);
  } catch {
    throw new Error('The encoded payload is malformed');
  }
  if (binary.length > HOST_WIRE_LIMITS.binaryBytes) {
    throw new Error('The decoded payload exceeds the allowed size');
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeBoundedBase64(bytes: Uint8Array): string {
  assertBoundedBytes(bytes);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  const encoded = globalThis.btoa(binary);
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
