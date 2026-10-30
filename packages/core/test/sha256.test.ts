import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../src/workspace-settings/catalog.js';
import { sha256Bytes } from '../src/workspace-settings/sha256.js';

function nodeHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('SHA-256 without Web Crypto', () => {
  it('matches the platform digest across every padding boundary', () => {
    // 55 and 56 bytes straddle the length field; 64 fills a block exactly.
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 31 + 7) & 0xff);
      expect(hex(sha256Bytes(bytes)), `${length} bytes`).to.equal(nodeHex(bytes));
    }
  });

  it('matches the published test vectors', () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(hex(sha256Bytes(encode('')))).to.equal(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(hex(sha256Bytes(encode('abc')))).to.equal(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('gives catalogs the same hash when the host has no global crypto', async () => {
    const text = '---\ntitle: Café ☕\n---\n# Notes 👩🏽‍💻\n\nLine one.\nLine two.\n';
    const withWebCrypto = await sha256Hex(text);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    // As on VS Code 1.85's Node 18 extension host.
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    try {
      expect(await sha256Hex(text)).to.equal(withWebCrypto);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    }
    expect(withWebCrypto).to.equal(nodeHex(new TextEncoder().encode(text)));
  });
});
