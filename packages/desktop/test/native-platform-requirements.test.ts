import { expect } from 'chai';
import { rejects } from 'node:assert/strict';
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  machoMinimums,
  elfGlibcRequirements,
  verifyNativePlatformRequirements,
} = require('../scripts/native-platform-requirements.cjs');

function macho(version: [number, number, number], command = 0x32): Buffer {
  const bytes = Buffer.alloc(56);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(command, 32);
  bytes.writeUInt32LE(24, 36);
  if (command === 0x32) bytes.writeUInt32LE(1, 40);
  bytes.writeUInt32LE(
    (version[0] << 16) | (version[1] << 8) | version[2],
    command === 0x32 ? 44 : 40,
  );
  return bytes;
}

/** Minimal ELF64 with a real VERNEED chain and a distracting, unused GLIBC string. */
function elf(version: string): Buffer {
  const strings = Buffer.from(`\0GLIBC_${version}\0GLIBC_99.0\0`);
  const bytes = Buffer.alloc(384);
  Buffer.from('7f454c460201', 'hex').copy(bytes);
  bytes.writeBigUInt64LE(64n, 40);
  bytes.writeUInt16LE(64, 58);
  bytes.writeUInt16LE(3, 60);
  bytes.writeUInt32LE(3, 128 + 4); // SHT_STRTAB
  bytes.writeBigUInt64LE(256n, 128 + 24);
  bytes.writeBigUInt64LE(BigInt(strings.length), 128 + 32);
  bytes.writeUInt32LE(0x6ffffffe, 192 + 4); // SHT_GNU_verneed
  bytes.writeBigUInt64LE(320n, 192 + 24);
  bytes.writeBigUInt64LE(32n, 192 + 32);
  bytes.writeUInt32LE(1, 192 + 40); // linked strings
  strings.copy(bytes, 256);
  bytes.writeUInt16LE(1, 320);
  bytes.writeUInt16LE(1, 322);
  bytes.writeUInt32LE(16, 328);
  bytes.writeUInt32LE(1, 336 + 8); // GLIBC name offset
  return bytes;
}

describe('native binary OS metadata', () => {
  it('reads modern and legacy Mach-O minimum OS commands', () => {
    expect(machoMinimums(macho([13, 3, 0]))).to.deep.equal(['13.3.0']);
    expect(machoMinimums(macho([11, 0, 0], 0x24))).to.deep.equal(['11.0.0']);
  });
  it('reads required ELF versions instead of incidental strings or exported versions', () => {
    expect(elfGlibcRequirements(elf('2.38'))).to.deep.equal(['2.38']);
    const exported = elf('99.0');
    exported.writeUInt32LE(0x6ffffffd, 192 + 4); // VERDEF is not a dependency
    expect(elfGlibcRequirements(exported)).to.deep.equal([]);
  });
  it('rejects malformed binary metadata instead of assuming compatibility', () => {
    expect(() => machoMinimums(macho([13, 3, 0]).subarray(0, 40))).to.throw('metadata');
    expect(() => elfGlibcRequirements(elf('2.38').subarray(0, 330))).to.throw('metadata');
    const looping = elf('2.38');
    looping.writeUInt32LE(1, 332);
    expect(() => elfGlibcRequirements(looping)).to.throw('chain');
    expect(() => machoMinimums(Buffer.from('cafebabe', 'hex'))).to.throw('thin 64-bit');
  });
});

describe('native payload OS contract', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'docblocks-native-platform-'));
    await mkdir(path.join(directory, 'dependencies'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('checks a newer Mach-O requirement in a supporting library, not just the server', async () => {
    await writeFile(path.join(directory, 'gezel-llama-server'), macho([13, 3, 0]));
    await writeFile(path.join(directory, 'dependencies', 'libggml.dylib'), macho([14, 0, 0]));
    await rejects(
      verifyNativePlatformRequirements({ directory, platform: 'darwin' }),
      /libggml\.dylib requires macOS 14\.0\.0/,
    );
  });
  it('checks required GLIBC symbols in every ELF dependency', async () => {
    await writeFile(path.join(directory, 'gezel-llama-server'), elf('2.34'));
    const library = path.join(directory, 'dependencies', 'libwhisper.so');
    await writeFile(library, elf('2.38'));
    await writeFile(
      path.join(directory, 'model-description.txt'),
      'GLIBC_99.0 is not a dependency',
    );
    const result = await verifyNativePlatformRequirements({ directory, platform: 'linux' });
    expect(result.binaries).to.have.length(2);
    expect(result.binaries.map((entry: { minimum: string }) => entry.minimum)).to.include('2.38');
    await writeFile(library, elf('2.39'));
    await rejects(
      verifyNativePlatformRequirements({ directory, platform: 'linux' }),
      /libwhisper\.so requires glibc 2\.39/,
    );
  });
  it('refuses an empty payload on Unix and leaves Windows verification to its own policy', async () => {
    await rejects(
      verifyNativePlatformRequirements({ directory, platform: 'linux' }),
      /No linux binaries/,
    );
    expect(await verifyNativePlatformRequirements({ directory, platform: 'win32' })).to.deep.equal({
      binaries: [],
    });
  });
  it('admits an empty payload only when asked, still checking any binaries present', async () => {
    await writeFile(path.join(directory, 'release.json'), '{"archives":[]}');
    expect(
      await verifyNativePlatformRequirements({ directory, platform: 'darwin', allowEmpty: true }),
    ).to.deep.equal({ binaries: [] });
    await rejects(verifyNativePlatformRequirements({ directory, platform: 'darwin' }), /No darwin/);
    await writeFile(path.join(directory, 'gezel-llama-server'), macho([99, 0, 0]));
    await rejects(
      verifyNativePlatformRequirements({ directory, platform: 'darwin', allowEmpty: true }),
      /requires macOS 99\.0\.0/,
    );
  });
  it('reads bounded metadata from a large library without reading its code or data', async () => {
    const library = path.join(directory, 'large-gpu-library.so');
    await writeFile(library, elf('2.38'));
    const handle = await open(library, 'r+');
    try {
      await handle.truncate(800 * 1024 * 1024);
    } finally {
      await handle.close();
    }
    const result = await verifyNativePlatformRequirements({ directory, platform: 'linux' });
    expect(result.binaries).to.deep.equal([{ path: 'large-gpu-library.so', minimum: '2.38' }]);
  });
});
