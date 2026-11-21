import { expect } from 'chai';
import { parseFileSystemCapabilities } from '../src/filesystem/capabilities.js';
import { parseWorkspacePath } from '../src/filesystem/workspace-path.js';
import {
  createMobileFileSystemBridge,
  encodeMobileBytes,
  MOBILE_STORAGE_LIMITS,
  type MobileFsRequest,
} from '../src/host/mobile-wire.js';

const capabilities = parseFileSystemCapabilities({
  writeAtomicity: 'process',
  moveAtomicity: 'process',
  snapshotAtomicity: 'process',
  conditionalWrite: 'process',
  recursiveRemove: true,
  watch: false,
  caseSensitivity: 'platform',
  symlinkPolicy: 'reject',
  durability: 'best-effort',
});

const PENDING_LIMIT = 32;
const busy = {
  ok: false,
  error: {
    name: 'FsError',
    code: 'busy',
    message: 'Native storage: busy.',
    operation: null,
    path: null,
    destinationPath: null,
    retryable: true,
  },
};

/**
 * Native storage as the page meets it: one request at a time, and a refusal,
 * not a queue, past its limits on waiting requests and on open transfers.
 */
function nativeStorage(content = 'hello') {
  const open = new Set<string>();
  let sequence = 0;
  let pending = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const seen = { mostPending: 0, mostOpen: 0, refused: 0 };
  const bytes = new TextEncoder().encode(content);
  const entry = (path: string) => ({
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    version: 'v1',
    lastModified: '2026-11-20T10:36:12.000Z',
    kind: 'file',
    size: bytes.length,
  });
  const handle = (request: MobileFsRequest): unknown => {
    switch (request.op) {
      case 'readBegin': {
        if (open.size >= MOBILE_STORAGE_LIMITS.transfers) {
          seen.refused += 1;
          return busy;
        }
        const transferId = `transfer-${++sequence}`;
        open.add(transferId);
        seen.mostOpen = Math.max(seen.mostOpen, open.size);
        return { ok: true, value: { transferId, entry: entry(request.path) } };
      }
      case 'writeBegin': {
        if (open.size >= MOBILE_STORAGE_LIMITS.transfers) {
          seen.refused += 1;
          return busy;
        }
        const transferId = `transfer-${++sequence}`;
        open.add(transferId);
        seen.mostOpen = Math.max(seen.mostOpen, open.size);
        return { ok: true, value: transferId };
      }
      case 'readChunk':
        return { ok: true, value: encodeMobileBytes(bytes) };
      case 'writeChunk':
        return { ok: true, value: null };
      case 'writeFinish':
        open.delete(request.transferId);
        return { ok: true, value: entry('written.md') };
      case 'closeTransfer':
        open.delete(request.transferId);
        return { ok: true, value: null };
      default:
        return { ok: true, value: null };
    }
  };
  const send = (request: MobileFsRequest): Promise<unknown> => {
    if (pending >= PENDING_LIMIT) {
      seen.refused += 1;
      return Promise.reject(new Error('Device storage is busy. Try again.'));
    }
    pending += 1;
    seen.mostPending = Math.max(seen.mostPending, pending);
    const run = tail.then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      try {
        return handle(request);
      } finally {
        pending -= 1;
      }
    });
    tail = run.catch(() => undefined);
    return run;
  };
  return { send, seen, open };
}

describe('mobile filesystem bridge takes turns with native storage', () => {
  it('reads many files at once without overrunning the open-transfer limit', async () => {
    const native = nativeStorage();
    const bridge = createMobileFileSystemBridge(native.send, capabilities);
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        bridge.readFile('instance', parseWorkspacePath(`note-${index}.md`)),
      ),
    );
    expect(results.every((result) => result.ok && result.value !== null)).to.equal(true);
    expect(native.seen.refused).to.equal(0);
    expect(native.seen.mostOpen).to.equal(MOBILE_STORAGE_LIMITS.transfers);
    expect(native.open.size).to.equal(0);
  });

  it('never has more requests waiting than native storage will hold', async () => {
    const native = nativeStorage();
    const bridge = createMobileFileSystemBridge(native.send, capabilities);
    const results = await Promise.all(
      Array.from({ length: 120 }, (_, index) =>
        bridge.stat('instance', parseWorkspacePath(`note-${index}.md`)),
      ),
    );
    expect(results.every((result) => result.ok)).to.equal(true);
    expect(native.seen.refused).to.equal(0);
    expect(native.seen.mostPending).to.be.at.most(8);
  });

  it('mixes reads and writes under the same limit and frees every slot', async () => {
    const native = nativeStorage();
    const bridge = createMobileFileSystemBridge(native.send, capabilities);
    const data = new TextEncoder().encode('written');
    const work = Array.from({ length: 24 }, (_, index) =>
      index % 2 === 0
        ? bridge.readFile('instance', parseWorkspacePath(`note-${index}.md`))
        : bridge.writeFile('instance', parseWorkspacePath(`note-${index}.md`), data),
    );
    const results = await Promise.all(work);
    expect(results.every((result) => result.ok)).to.equal(true);
    expect(native.seen.refused).to.equal(0);
    expect(native.seen.mostOpen).to.be.at.most(MOBILE_STORAGE_LIMITS.transfers);
    // A further read is not left waiting on a slot that was never returned.
    expect((await bridge.readFile('instance', parseWorkspacePath('after.md'))).ok).to.equal(true);
  });

  it('gives a slot back when a transfer never opens', async () => {
    const native = nativeStorage();
    let fail = true;
    const bridge = createMobileFileSystemBridge((request) => {
      if (request.op === 'readBegin' && fail) return Promise.resolve({ ok: true, value: null });
      return native.send(request);
    }, capabilities);
    // Missing files open no transfer; more of them than there are slots must not stall.
    const missing = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        bridge.readFile('instance', parseWorkspacePath(`missing-${index}.md`)),
      ),
    );
    expect(missing.every((result) => result.ok && result.value === null)).to.equal(true);
    fail = false;
    expect((await bridge.readFile('instance', parseWorkspacePath('there.md'))).ok).to.equal(true);
  });
});
