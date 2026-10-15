/** Check declared ABI requirements, including every shared library in the payload. */
const { open, readdir } = require('node:fs/promises');
const path = require('node:path');
const policy = require('../native-platform-policy.json');

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function range(bytes, start, size) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(size) ||
    start < 0 ||
    size < 0 ||
    start + size > bytes.length
  )
    throw new Error('Truncated or invalid native binary metadata');
  return bytes.subarray(start, start + size);
}

function machoMinimums(bytes) {
  if (bytes.length < 4) return null;
  const magic = bytes.readUInt32LE(0);
  if (
    [0xfeedface, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(
      magic,
    )
  )
    throw new Error('Expected a thin 64-bit little-endian Mach-O');
  if (magic !== 0xfeedfacf) return null;
  range(bytes, 0, 32);
  const count = bytes.readUInt32LE(16);
  const end = 32 + bytes.readUInt32LE(20);
  range(bytes, 32, end - 32);
  let offset = 32;
  const versions = [];
  for (let index = 0; index < count; index++) {
    const command = range(bytes, offset, 8).readUInt32LE(0);
    const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > end) throw new Error('Invalid Mach-O load command');
    const body = range(bytes, offset, size);
    if (command === 0x24 || command === 0x32) {
      if (body.length < (command === 0x32 ? 24 : 16))
        throw new Error('Truncated Mach-O minimum OS');
      if (command === 0x32 && body.readUInt32LE(8) !== 1)
        throw new Error('Native payload targets a non-macOS platform');
      const version = body.readUInt32LE(command === 0x32 ? 12 : 8);
      versions.push(`${version >>> 16}.${(version >>> 8) & 255}.${version & 255}`);
    }
    offset += size;
  }
  if (!versions.length) throw new Error('Mach-O binary has no declared minimum OS');
  return versions;
}

/** Read ELF VERNEED, never incidental GLIBC strings or exported VERDEF symbols. */
function elfGlibcRequirements(bytes) {
  if (bytes.subarray(0, 4).toString('hex') !== '7f454c46') return null;
  range(bytes, 0, 64);
  if (bytes[4] !== 2 || bytes[5] !== 1) throw new Error('Expected a 64-bit little-endian ELF');
  const offset = Number(bytes.readBigUInt64LE(40));
  const size = bytes.readUInt16LE(58);
  const count = bytes.readUInt16LE(60);
  if (!count || size < 64) throw new Error('ELF section metadata is missing');
  range(bytes, offset, count * size);
  const sections = Array.from({ length: count }, (_, index) => {
    const header = range(bytes, offset + index * size, 64);
    return {
      type: header.readUInt32LE(4),
      offset: Number(header.readBigUInt64LE(24)),
      size: Number(header.readBigUInt64LE(32)),
      link: header.readUInt32LE(40),
    };
  });
  const versions = [];
  for (const section of sections.filter((entry) => entry.type === 0x6ffffffe)) {
    const names = sections[section.link];
    if (!names || names.type !== 3) throw new Error('Invalid ELF version string table');
    const strings = range(bytes, names.offset, names.size);
    const records = range(bytes, section.offset, section.size);
    let position = 0;
    for (;;) {
      const record = range(records, position, 16);
      const entries = record.readUInt16LE(2);
      let auxiliary = position + record.readUInt32LE(8);
      for (let index = 0; index < entries; index++) {
        const entry = range(records, auxiliary, 16);
        const start = entry.readUInt32LE(8);
        const end = strings.indexOf(0, start);
        if (end < 0 || start >= strings.length) throw new Error('Invalid ELF version name');
        const name = strings.toString('utf8', start, end);
        if (/^GLIBC_\d+\.\d+(?:\.\d+)?$/.test(name)) versions.push(name.slice(6));
        const next = entry.readUInt32LE(12);
        if (index + 1 < entries && next < 16)
          throw new Error('Invalid ELF version auxiliary chain');
        auxiliary += next;
      }
      const next = record.readUInt32LE(12);
      if (next === 0) break;
      if (next < 16) throw new Error('Invalid ELF version requirement chain');
      position += next;
    }
  }
  return versions;
}

/** Read only load commands / version sections, even for very large GPU libraries. */
async function binaryMetadata(handle, platform) {
  const fileSize = (await handle.stat()).size;
  let remaining = 32 * 1024 * 1024;
  async function read(position, size) {
    if (
      !Number.isSafeInteger(position) ||
      !Number.isSafeInteger(size) ||
      position < 0 ||
      size < 0 ||
      position + size > fileSize
    )
      throw new Error('Truncated or invalid native binary metadata');
    if (size > remaining) throw new Error('Native metadata exceeds the 32 MiB inspection limit');
    remaining -= size;
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const result = await handle.read(bytes, offset, size - offset, position + offset);
      if (!result.bytesRead) throw new Error('Truncated native binary metadata');
      offset += result.bytesRead;
    }
    return bytes;
  }
  if (platform === 'darwin') {
    const header = await read(0, 32);
    if (header.readUInt32LE(0) !== 0xfeedfacf) machoMinimums(header);
    return Buffer.concat([header, await read(32, header.readUInt32LE(20))]);
  }
  const header = await read(0, 64);
  if (header[4] !== 2 || header[5] !== 1) throw new Error('Expected a 64-bit little-endian ELF');
  const size = header.readUInt16LE(58);
  const count = header.readUInt16LE(60);
  if (!count || size < 64) throw new Error('ELF section metadata is missing');
  const table = await read(Number(header.readBigUInt64LE(40)), count * size);
  const needed = new Set();
  for (let index = 0; index < count; index++) {
    if (table.readUInt32LE(index * size + 4) === 0x6ffffffe) {
      needed.add(index);
      needed.add(table.readUInt32LE(index * size + 40));
    }
  }
  // Relocate just the version metadata into a bounded buffer for the same parser.
  header.writeBigUInt64LE(64n, 40);
  const parts = [header, table];
  let end = header.length + table.length;
  for (const index of needed) {
    if (index >= count) throw new Error('Invalid ELF version string table');
    const entry = table.subarray(index * size, index * size + 64);
    const data = await read(Number(entry.readBigUInt64LE(24)), Number(entry.readBigUInt64LE(32)));
    entry.writeBigUInt64LE(BigInt(end), 24);
    parts.push(data);
    end += data.length;
  }
  return Buffer.concat(parts);
}

async function verifyNativePlatformRequirements({ directory, platform }) {
  if (!['darwin', 'linux'].includes(platform)) return { binaries: [] };
  const baseline = platform === 'darwin' ? policy.macNativeMinimum : policy.linuxNativeGlibcMinimum;
  const binaries = [];
  let fileCount = 0;
  async function visit(folder, depth = 0) {
    if (depth > 20) throw new Error('Native payload exceeds the directory depth limit');
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (++fileCount > 10_000) throw new Error('Native payload exceeds the file count limit');
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(file, depth + 1);
      // Upstream pin verification owns symlink containment; inspect each real target once.
      else if (entry.isFile()) {
        const handle = await open(file, 'r');
        let versions;
        try {
          const prefix = Buffer.alloc(4);
          const { bytesRead } = await handle.read(prefix, 0, 4, 0);
          if (bytesRead < 4) continue;
          // Skip data assets without reading them into memory.
          const magic = prefix.readUInt32LE(0);
          const isBinary =
            platform === 'darwin'
              ? [
                  0xfeedfacf, 0xfeedface, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
                  0xcafebabf, 0xbfbafeca,
                ].includes(magic)
              : magic === 0x464c457f;
          if (!isBinary) continue;
          const bytes = await binaryMetadata(handle, platform);
          versions = platform === 'darwin' ? machoMinimums(bytes) : elfGlibcRequirements(bytes);
        } catch (error) {
          throw new Error(`${path.relative(directory, file)}: ${error.message}`);
        } finally {
          await handle.close();
        }
        if (versions === null) continue;
        const minimum = versions.sort(compareVersions).at(-1) ?? null;
        if (minimum && compareVersions(minimum, baseline) > 0) {
          throw new Error(
            `${path.relative(directory, file)} requires ${platform === 'darwin' ? 'macOS' : 'glibc'} ${minimum}, above the declared native feature baseline ${baseline}. Rebuild the engine or update the runtime gate and support policy.`,
          );
        }
        binaries.push({ path: path.relative(directory, file), minimum });
      }
    }
  }
  await visit(directory);
  if (!binaries.length)
    throw new Error(`No ${platform} binaries found in native payload ${directory}`);
  return { binaries };
}

module.exports = {
  compareVersions,
  machoMinimums,
  elfGlibcRequirements,
  verifyNativePlatformRequirements,
};
