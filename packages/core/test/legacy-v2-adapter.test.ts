import { expect } from 'chai';
import {
  LegacyFileSystemProviderV2Adapter,
  MemoryFileSystemProvider,
  MemoryFileSystemProviderV2,
  getFileSystemProviderV2,
  hasFileSystemProviderV2,
  parseWorkspacePath,
  type FileSystemEntry,
  type FileSystemProvider,
  type FileSystemProviderV2,
} from '../src/filesystem/index.js';
import {
  defineFileSystemProviderV2Conformance,
  expectFsError,
} from './helpers/filesystem-v2-conformance.js';

let providerId = 0;
defineFileSystemProviderV2Conformance('Legacy Memory adapter', () => {
  const id = `legacy-adapter-${++providerId}`;
  return new LegacyFileSystemProviderV2Adapter(new HardenedSplitMemory(id, 'Legacy'), {
    payloadModel: 'split',
    writeAtomicity: 'process',
    moveAtomicity: 'process',
    caseSensitivity: 'sensitive',
    durability: 'volatile',
  });
});

describe('LegacyFileSystemProviderV2Adapter', () => {
  it('declares only the guarantees the adapter can actually provide', async () => {
    const provider = adapter(new HardenedSplitMemory('capabilities', 'Capabilities'), 'split');
    expect(provider.capabilities).to.deep.equal({
      writeAtomicity: 'none',
      moveAtomicity: 'none',
      snapshotAtomicity: 'none',
      conditionalWrite: 'process',
      recursiveRemove: true,
      watch: false,
      caseSensitivity: 'sensitive',
      symlinkPolicy: 'unsupported',
      durability: 'volatile',
    });
    expect(Object.isFrozen(provider.capabilities)).to.equal(true);
    await provider.dispose();
  });

  it('adapts split text/binary stores into one owned byte payload', async () => {
    const legacy = new HardenedSplitMemory('split', 'Split');
    legacy.seedText('/text.md', 'legacy text');
    const provider = adapter(legacy, 'split');

    const first = await provider.readFile(parseWorkspacePath('/text.md'));
    expect(decode(first?.data)).to.equal('legacy text');
    new Uint8Array(first!.data)[0] = 0;
    expect(decode((await provider.readFile(parseWorkspacePath('/text.md')))?.data)).to.equal(
      'legacy text',
    );

    await provider.writeFile(parseWorkspacePath('/text.md'), encode('v2 bytes'));
    expect(decode(await legacy.readBinary('/text.md'))).to.equal('v2 bytes');
    await provider.dispose();
  });

  it('uses only the byte channel for binary-authoritative native-style providers', async () => {
    const legacy = new BinaryAuthoritativeMemory('binary', 'Binary');
    await legacy.writeBinary('/asset.bin', new Uint8Array([0, 255, 8]));
    const provider = adapter(legacy, 'binary-authoritative');

    expect(bytes((await provider.readFile(parseWorkspacePath('/asset.bin')))?.data)).to.deep.equal([
      0, 255, 8,
    ]);
    expect(legacy.textReadCount).to.equal(0);
    await provider.dispose();
  });

  it('supports legacy stores whose text API synthesizes a binary fallback', async () => {
    const legacy = new MemoryFileSystemProvider('fallback', 'Fallback');
    legacy.seedText('/note.md', 'text');
    expect(decode((await legacy.v2.readFile(parseWorkspacePath('/note.md')))?.data)).to.equal(
      'text',
    );

    await legacy.writeBinary('/note.md', new Uint8Array([0, 255, 8]));
    expect(bytes((await legacy.v2.readFile(parseWorkspacePath('/note.md')))?.data)).to.deep.equal([
      0, 255, 8,
    ]);
    await legacy.v2.dispose();
  });

  it('rejects ambiguous dual payloads instead of choosing an authority', async () => {
    const legacy = new DualPayloadMemory('dual', 'Dual');
    legacy.seedText('/ambiguous.dat', 'text');
    const provider = adapter(legacy, 'split');

    await expectFsError(provider.readFile(parseWorkspacePath('/ambiguous.dat')), 'conflict');
    await provider.dispose();
  });

  it('detects out-of-band legacy changes with content-derived CAS versions', async () => {
    const legacy = new HardenedSplitMemory('cas', 'CAS');
    await legacy.writeBinary('/note.md', encode('baseline'));
    const provider = adapter(legacy, 'split');
    const baseline = await provider.readFile(parseWorkspacePath('/note.md'));

    await legacy.writeBinary('/note.md', encode('external'));
    await expectFsError(
      provider.writeFile(parseWorkspacePath('/note.md'), encode('stale local'), {
        expectedVersion: baseline!.entry.version,
      }),
      'conflict',
    );
    expect(decode((await provider.readFile(parseWorkspacePath('/note.md')))?.data)).to.equal(
      'external',
    );
    await provider.dispose();
  });

  it('maps legacy platform faults and does not poison the serialized operation queue', async () => {
    const legacy = new OneShotFaultingMemory('fault', 'Fault');
    const provider = adapter(legacy, 'split');

    await expectFsError(
      provider.writeFile(parseWorkspacePath('/first.md'), encode('first')),
      'permission-denied',
    );
    await provider.writeFile(parseWorkspacePath('/second.md'), encode('second'));
    expect(decode((await provider.readFile(parseWorkspacePath('/second.md')))?.data)).to.equal(
      'second',
    );
    await provider.dispose();
  });

  it('rejects malformed legacy listings with a typed path error', async () => {
    const legacy = new EscapingListingMemory('escape', 'Escape');
    const provider = adapter(legacy, 'split');

    await expectFsError(provider.snapshot(), 'path-escape');
    await provider.dispose();
  });

  it('serializes mutations and snapshots through one boundary', async () => {
    const legacy = new ConcurrentTrackingMemory('serial', 'Serial');
    const provider = adapter(legacy, 'split');

    await Promise.all([
      provider.writeFile(parseWorkspacePath('/one.md'), encode('one')),
      provider.writeFile(parseWorkspacePath('/two.md'), encode('two')),
      provider.snapshot(),
    ]);
    expect(legacy.maximumConcurrentWrites).to.equal(1);
    await provider.dispose();
  });

  it('owns disposal only when configured and makes a failing disposal idempotent', async () => {
    const legacy = new MemoryFileSystemProvider('dispose', 'Dispose');
    let disposeCalls = 0;
    const provider = new LegacyFileSystemProviderV2Adapter(legacy, {
      payloadModel: 'split',
      dispose: () => {
        disposeCalls += 1;
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      },
    });

    const first = provider.dispose();
    const second = provider.dispose();
    expect(second).to.equal(first);
    await expectFsError(first, 'busy');
    expect(disposeCalls).to.equal(1);
    await expectFsError(provider.snapshot(), 'disposed');
  });
});

describe('FileSystemProvider v2 discovery seam', () => {
  it('keeps v1 mocks valid and discovers an optional provider-owned v2 implementation', async () => {
    const legacy = legacyFacade(new MemoryFileSystemProvider('legacy', 'Legacy'));
    expect(hasFileSystemProviderV2(legacy)).to.equal(false);
    expect(getFileSystemProviderV2(legacy)).to.equal(null);

    const v2 = new MemoryFileSystemProviderV2('owned-v2', 'Owned v2');
    const discoverable = legacyFacade(
      new MemoryFileSystemProvider('discoverable', 'Discoverable'),
      v2,
    );
    expect(hasFileSystemProviderV2(discoverable)).to.equal(true);
    expect(getFileSystemProviderV2(discoverable)).to.equal(v2);
    await v2.dispose();
  });
});

function adapter(
  provider: FileSystemProvider,
  payloadModel: 'split' | 'binary-authoritative',
): LegacyFileSystemProviderV2Adapter {
  return new LegacyFileSystemProviderV2Adapter(provider, {
    payloadModel,
    caseSensitivity: 'sensitive',
    durability: 'volatile',
  });
}

class BinaryAuthoritativeMemory extends MemoryFileSystemProvider {
  public textReadCount = 0;

  public override async readFile(path: string): Promise<string | null> {
    this.textReadCount += 1;
    return super.readFile(path);
  }
}

class HardenedSplitMemory extends MemoryFileSystemProvider {
  public override async readFile(path: string): Promise<string | null> {
    if ((await this.readBinary(path)) !== null) return null;
    return super.readFile(path);
  }
}

class DualPayloadMemory extends MemoryFileSystemProvider {
  public override async readBinary(path: string): Promise<ArrayBuffer | null> {
    if (parseWorkspacePath(path) === 'ambiguous.dat') return encode('binary').buffer;
    return super.readBinary(path);
  }
}

class OneShotFaultingMemory extends HardenedSplitMemory {
  private shouldFail = true;

  public override async writeBinary(path: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }
    await super.writeBinary(path, data);
  }
}

class EscapingListingMemory extends HardenedSplitMemory {
  public override async readDirectory(path: string): Promise<FileSystemEntry[]> {
    if (parseWorkspacePath(path) === '') {
      return [{ kind: 'file', name: 'escape.md', path: '../escape.md' }];
    }
    return super.readDirectory(path);
  }
}

class ConcurrentTrackingMemory extends HardenedSplitMemory {
  public maximumConcurrentWrites = 0;
  private concurrentWrites = 0;

  public override async writeBinary(path: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    this.concurrentWrites += 1;
    this.maximumConcurrentWrites = Math.max(this.maximumConcurrentWrites, this.concurrentWrites);
    await Promise.resolve();
    try {
      await super.writeBinary(path, data);
    } finally {
      this.concurrentWrites -= 1;
    }
  }
}

function legacyFacade(
  provider: MemoryFileSystemProvider,
  v2?: FileSystemProviderV2,
): FileSystemProvider {
  const legacy: FileSystemProvider = {
    id: provider.id,
    label: provider.label,
    readFile: (path) => provider.readFile(path),
    writeFile: (path, content) => provider.writeFile(path, content),
    delete: (path) => provider.delete(path),
    rename: (oldPath, newPath) => provider.rename(oldPath, newPath),
    readDirectory: (path) => provider.readDirectory(path),
    exists: (path) => provider.exists(path),
    createDirectory: (path) => provider.createDirectory(path),
    stat: (path) => provider.stat(path),
    readBinary: (path) => provider.readBinary(path),
    writeBinary: (path, data) => provider.writeBinary(path, data),
  };
  return v2 ? { ...legacy, v2 } : legacy;
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(value: ArrayBuffer | null | undefined): string | null {
  return value ? new TextDecoder().decode(value) : null;
}

function bytes(value: ArrayBuffer | undefined): number[] | null {
  return value ? [...new Uint8Array(value)] : null;
}
