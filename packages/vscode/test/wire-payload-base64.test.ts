import { expect } from 'chai';
import { atob as strictAtob } from 'node:buffer';
import {
  decodeBase64Portable,
  decodeBase64ViaNodeBuffer,
  decodeBoundedBase64,
  encodeBase64Portable,
  encodeBase64ViaNodeBuffer,
  encodeBoundedBase64,
} from '../src/wirePayload.js';

/**
 * The Node fast path is only safe because it is byte-for-byte interchangeable
 * with the portable path that the browser bundles (web extension host, webview)
 * still run. These tests are that equivalence argument: they compare the two
 * implementations directly, and they force the public functions down each path
 * in turn so the browser fallback cannot rot untested.
 */

const nodeBuffer = (globalThis as { Buffer?: unknown }).Buffer as Parameters<
  typeof encodeBase64ViaNodeBuffer
>[0];

/**
 * Strings that pass this module's own validation but that Buffer and atob
 * disagree about: Buffer decodes them, a conformant atob rejects them.
 */
const MISPADDED = ['QQ=', 'AA=', '==', 'A=', 'A==', 'Qz=', 'B/=', 'QUJDRA='] as const;

/**
 * Run `body` with a spec-conformant `atob`.
 *
 * The workspace mocha setup registers happy-dom globally, and happy-dom's atob
 * is not spec-conformant: it accepts mispadded input that both real browsers
 * and Node reject. Neither shipping surface has happy-dom's behaviour, so
 * tests about rejection must not be written against it.
 */
function withStrictAtob<T>(body: () => T): T {
  const globals = globalThis as { atob: typeof strictAtob };
  const saved = globals.atob;
  globals.atob = strictAtob;
  try {
    return body();
  } finally {
    globals.atob = saved;
  }
}

/** Run `body` with `globalThis.Buffer` removed, as in a browser bundle. */
function withoutNodeBuffer<T>(body: () => T): T {
  const globals = globalThis as { Buffer?: unknown };
  const saved = globals.Buffer;
  delete globals.Buffer;
  try {
    return body();
  } finally {
    globals.Buffer = saved;
  }
}

/** Every interesting shape of input we can think of. */
function* sampleBuffers(): Generator<{ label: string; bytes: Uint8Array }> {
  yield { label: 'empty', bytes: new Uint8Array(0) };

  // Every size from 0..600 exercises both padding forms ('=', '==', none) and
  // every offset within the 3-byte base64 group.
  for (let size = 0; size <= 600; size += 1) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + size) & 0xff;
    yield { label: `sequential size=${size}`, bytes };
  }

  // All 256 byte values, alone and in company.
  for (let value = 0; value < 256; value += 1) {
    yield { label: `single byte ${value}`, bytes: new Uint8Array([value]) };
    yield { label: `pair ${value}`, bytes: new Uint8Array([value, value]) };
    yield { label: `triple ${value}`, bytes: new Uint8Array([value, 0x00, 0xff]) };
  }

  // Around the 0x8000 chunk boundary of the portable loop, and +/- 1.
  const chunk = 0x8000;
  for (const size of [chunk - 1, chunk, chunk + 1, chunk * 2 - 1, chunk * 2, chunk * 2 + 1]) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = i & 0xff;
    yield { label: `chunk boundary size=${size}`, bytes };
  }

  // Random buffers.
  for (let trial = 0; trial < 40; trial += 1) {
    const size = Math.floor(Math.random() * 5000);
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    yield { label: `random#${trial} size=${size}`, bytes };
  }
}

describe('wirePayload base64 fast path', () => {
  it('exposes Node Buffer in this test environment', () => {
    // Guards the suite itself: if Buffer vanished, the "fast path" assertions
    // below would silently be testing the portable path against itself.
    expect(typeof nodeBuffer).to.equal('function');
  });

  describe('encode equivalence', () => {
    it('produces identical base64 on both paths for every sample', () => {
      let compared = 0;
      for (const { label, bytes } of sampleBuffers()) {
        const portable = encodeBase64Portable(bytes);
        const fast = encodeBase64ViaNodeBuffer(nodeBuffer, bytes);
        expect(fast, `encode mismatch for ${label}`).to.equal(portable);
        compared += 1;
      }
      expect(compared).to.be.greaterThan(1000);
    });

    it('matches a known-good reference encoding', () => {
      // Anchors both paths to reality rather than to each other.
      const bytes = new TextEncoder().encode('DocBlocks');
      expect(encodeBoundedBase64(bytes)).to.equal('RG9jQmxvY2tz');
      expect(withoutNodeBuffer(() => encodeBoundedBase64(bytes))).to.equal('RG9jQmxvY2tz');
    });

    it('encodes a Uint8Array view without including the surrounding bytes', () => {
      // A view with a non-zero byteOffset: the fast path must honour the
      // window, not encode the whole backing buffer.
      const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
      const view = backing.subarray(2, 5);
      const expected = encodeBase64Portable(view);
      expect(encodeBase64ViaNodeBuffer(nodeBuffer, view)).to.equal(expected);
      expect(encodeBoundedBase64(view)).to.equal(expected);
      expect(withoutNodeBuffer(() => encodeBoundedBase64(view))).to.equal(expected);
    });

    it('agrees on both paths through the public function', () => {
      for (const { label, bytes } of sampleBuffers()) {
        const viaFast = encodeBoundedBase64(bytes);
        const viaPortable = withoutNodeBuffer(() => encodeBoundedBase64(bytes));
        expect(viaFast, `public encode mismatch for ${label}`).to.equal(viaPortable);
      }
    });
  });

  describe('decode equivalence', () => {
    it('produces identical bytes on both paths for every sample', () => {
      const limit = 100 * 1024 * 1024;
      for (const { label, bytes } of sampleBuffers()) {
        const encoded = encodeBase64Portable(bytes);
        const portable = decodeBase64Portable(encoded, limit);
        const fast = decodeBase64ViaNodeBuffer(nodeBuffer, encoded, limit);
        expect(Array.from(fast), `decode mismatch for ${label}`).to.deep.equal(
          Array.from(portable),
        );
        expect(Array.from(portable), `round-trip lost data for ${label}`).to.deep.equal(
          Array.from(bytes),
        );
      }
    });

    it('round-trips through the public functions on both paths', () => {
      for (const { label, bytes } of sampleBuffers()) {
        const encoded = encodeBoundedBase64(bytes);
        expect(Array.from(decodeBoundedBase64(encoded)), `fast round-trip ${label}`).to.deep.equal(
          Array.from(bytes),
        );
        expect(
          Array.from(withoutNodeBuffer(() => decodeBoundedBase64(encoded))),
          `portable round-trip ${label}`,
        ).to.deep.equal(Array.from(bytes));
      }
    });

    it('returns an array that owns its buffer, never a pooled view', () => {
      // Buffer.from() hands back a window into a shared 64 KB pool for small
      // inputs. Leaking that would expose unrelated bytes to any caller that
      // reads `.buffer` (the webview media provider does exactly that).
      const decoded = decodeBoundedBase64('QUJD');
      expect(decoded.byteOffset).to.equal(0);
      expect(decoded.buffer.byteLength).to.equal(decoded.byteLength);
      expect(Array.from(decoded)).to.deep.equal([0x41, 0x42, 0x43]);
    });

    it('never routes a mispadded string to Buffer', () => {
      // The trap this fast path exists to avoid: Buffer.from() silently accepts
      // mispadded strings ("QQ=", "==") that atob() rejects. Letting one reach
      // Buffer would quietly widen what this wire boundary admits.
      //
      // Asserted structurally — by spying on Buffer — rather than through
      // behaviour, because the suite's happy-dom `atob` is itself lenient and
      // cannot express the rejection (see the strict-atob test below).
      const globals = globalThis as { Buffer?: unknown };
      const saved = globals.Buffer as { from(v: unknown, e: unknown): unknown };
      const seen: string[] = [];
      // Must be a *function* with a `.from`, mirroring the real Buffer: the
      // detect rejects a plain object, which would make this test pass
      // vacuously by pushing every input onto the portable path.
      const spy = function Buffer() {} as unknown as { from: (v: unknown, e: unknown) => unknown };
      spy.from = (value: unknown, encoding: unknown) => {
        if (typeof value === 'string') seen.push(value);
        return saved.from(value, encoding);
      };
      globals.Buffer = spy;
      try {
        // Sanity-check that the spy is actually adopted, so a future change to
        // the detect turns this into a failure rather than a silent no-op.
        decodeBoundedBase64('QUJD');
        expect(seen, 'the Buffer spy was never consulted').to.deep.equal(['QUJD']);
        seen.length = 0;

        for (const mispadded of MISPADDED) {
          try {
            decodeBoundedBase64(mispadded);
          } catch {
            // Rejection is the goal; leniency is happy-dom's, checked below.
          }
          expect(seen, `"${mispadded}" was handed to Buffer`).to.deep.equal([]);
        }
      } finally {
        globals.Buffer = saved;
      }
    });

    it('rejects mispadded strings on both paths under a spec-conformant atob', () => {
      // Node's atob matches the WHATWG forgiving-base64 algorithm that real
      // browsers implement, so it stands in for both shipping environments:
      // the Node extension host and the webview. happy-dom's atob does not
      // (it accepts every string below), so swap the conformant one back in.
      withStrictAtob(() => {
        for (const mispadded of MISPADDED) {
          expect(() => decodeBoundedBase64(mispadded), `fast path allowed "${mispadded}"`).to.throw(
            'malformed',
          );
          expect(
            () => withoutNodeBuffer(() => decodeBoundedBase64(mispadded)),
            `portable path allowed "${mispadded}"`,
          ).to.throw('malformed');
        }
      });
    });

    it('still round-trips valid payloads under a spec-conformant atob', () => {
      withStrictAtob(() => {
        for (const { label, bytes } of sampleBuffers()) {
          const encoded = encodeBoundedBase64(bytes);
          expect(
            Array.from(withoutNodeBuffer(() => decodeBoundedBase64(encoded))),
            `strict-atob round-trip ${label}`,
          ).to.deep.equal(Array.from(bytes));
        }
      });
    });

    it('keeps every existing malformed-input rejection', () => {
      expect(() => decodeBoundedBase64('A')).to.throw('exceeds the allowed size or is malformed');
      expect(() => decodeBoundedBase64('!!!!')).to.throw('malformed');
      expect(() => decodeBoundedBase64('A=AA')).to.throw('malformed');
      expect(() => decodeBoundedBase64('AA=A')).to.throw('malformed');
      expect(() => decodeBoundedBase64('QQ==QQ==')).to.throw('malformed');
    });

    it('accepts unpadded input identically on both paths', () => {
      // length % 4 === 2 or 3: the fast path declines these and defers to atob.
      for (const unpadded of ['QQ', 'QUJ', 'RG9jQmxvY2t6', 'QUJDRA']) {
        const viaPublic = Array.from(decodeBoundedBase64(unpadded));
        const viaPortable = Array.from(withoutNodeBuffer(() => decodeBoundedBase64(unpadded)));
        expect(viaPublic, `unpadded mismatch for "${unpadded}"`).to.deep.equal(viaPortable);
      }
    });
  });

  describe('bounds are enforced on both paths', () => {
    const limit = 100 * 1024 * 1024;

    it('rejects a decoded payload over the byte cap on both paths', () => {
      // 8 base64 chars -> 6 bytes; a 5-byte cap must reject both ways.
      const encoded = encodeBase64Portable(new Uint8Array(6));
      expect(() => decodeBase64Portable(encoded, 5)).to.throw('decoded payload exceeds');
      expect(() => decodeBase64ViaNodeBuffer(nodeBuffer, encoded, 5)).to.throw(
        'decoded payload exceeds',
      );
      // ...and accepts at exactly the cap, on both paths.
      expect(decodeBase64Portable(encoded, 6)).to.have.length(6);
      expect(decodeBase64ViaNodeBuffer(nodeBuffer, encoded, 6)).to.have.length(6);
    });

    it('rejects oversized byte payloads on both paths', () => {
      const oversized = { byteLength: limit + 1 } as unknown as Uint8Array;
      expect(() => encodeBoundedBase64(oversized)).to.throw('payload exceeds the allowed size');
      expect(() => withoutNodeBuffer(() => encodeBoundedBase64(oversized))).to.throw(
        'payload exceeds the allowed size',
      );
    });

    it('rejects non-byte payloads on both paths', () => {
      const notBytes = 'nope' as unknown as Uint8Array;
      expect(() => encodeBoundedBase64(notBytes)).to.throw('payload exceeds the allowed size');
      expect(() => withoutNodeBuffer(() => encodeBoundedBase64(notBytes))).to.throw(
        'payload exceeds the allowed size',
      );
    });

    it('rejects an over-long encoded string before decoding it', () => {
      const tooLong = 'A'.repeat(140 * 1024 * 1024 + 4);
      expect(() => decodeBoundedBase64(tooLong)).to.throw(
        'exceeds the allowed size or is malformed',
      );
    });
  });

  describe('path selection', () => {
    it('uses the portable path when Buffer is absent', () => {
      withoutNodeBuffer(() => {
        expect((globalThis as { Buffer?: unknown }).Buffer).to.equal(undefined);
        expect(encodeBoundedBase64(new TextEncoder().encode('hi'))).to.equal('aGk=');
        expect(Array.from(decodeBoundedBase64('aGk='))).to.deep.equal([0x68, 0x69]);
      });
    });

    it('ignores a Buffer global that is not usable', () => {
      // A browser bundle could plausibly carry some unrelated `Buffer` global;
      // only something with a callable `.from` may be trusted.
      const globals = globalThis as { Buffer?: unknown };
      const saved = globals.Buffer;
      globals.Buffer = function Buffer() {} as unknown;
      try {
        expect(encodeBoundedBase64(new TextEncoder().encode('hi'))).to.equal('aGk=');
        expect(Array.from(decodeBoundedBase64('aGk='))).to.deep.equal([0x68, 0x69]);
      } finally {
        globals.Buffer = saved;
      }
    });
  });
});
