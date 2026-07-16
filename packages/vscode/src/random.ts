interface NodeCryptoModule {
  randomFillSync<T extends ArrayBufferView>(buffer: T): T;
}

interface CommonJsModule {
  require(id: 'node:crypto'): NodeCryptoModule;
}

declare const module: CommonJsModule | undefined;

/** Fill bytes securely in both web extension workers and older desktop hosts. */
export function fillRandomBytes(bytes: Uint8Array): void {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
    return;
  }

  // VS Code 1.85's desktop extension host predates a reliable global Web
  // Crypto object. Its CommonJS host still exposes Node's cryptographic RNG.
  if (typeof module !== 'undefined' && typeof module.require === 'function') {
    module.require('node:crypto').randomFillSync(bytes);
    return;
  }

  throw new Error('A cryptographically secure random source is unavailable');
}
