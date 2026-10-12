/**
 * Prove the staged Visual C++ runtime covers every binary in a Windows package.
 *
 * `stage-vc-runtime.cjs` copies a fixed list of DLLs. When a bundled binary
 * imports one that is not on it, the loader refuses that binary on machines
 * without the redistributable, and developer machines always have it, so
 * nothing else notices. The 2.7.0 candidate shipped ONNX Runtime importing
 * MSVCP140_1.dll this way, which broke narration on clean Windows installs.
 * afterPack reads every PE import table (regular and delay-load) in the
 * packaged app and fails when a Visual C++ runtime import is not staged.
 */
const { open, readdir } = require('node:fs/promises');
const path = require('node:path');

const VC_RUNTIME_DLL =
  /^(?:msvcp140(?:_[a-z0-9_]+)?|vcruntime140(?:_[a-z0-9_]+)?|concrt140|vccorlib140|vcomp140)\.dll$/iu;
const PE_EXTENSIONS = new Set(['.dll', '.exe', '.node']);
const MAX_DESCRIPTORS = 4096;

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/**
 * DLL names a PE file imports, directly or by delay load, or null when the file
 * is not a PE image. Reads headers and import tables only, never whole files.
 */
async function peImports(file) {
  const handle = await open(file, 'r');
  try {
    const dos = await readAt(handle, 0, 64);
    if (dos.length < 64 || dos.readUInt16LE(0) !== 0x5a4d) return null;
    const pe = dos.readUInt32LE(0x3c);
    const header = await readAt(handle, pe, 24);
    if (header.length < 24 || header.readUInt32LE(0) !== 0x00004550) return null;
    const sectionCount = header.readUInt16LE(6);
    const optionalSize = header.readUInt16LE(20);
    const optional = await readAt(handle, pe + 24, optionalSize);
    if (optional.length < 2) return null;
    const magic = optional.readUInt16LE(0);
    if (magic !== 0x10b && magic !== 0x20b) return null;
    const directoriesAt = magic === 0x20b ? 112 : 96;
    if (optional.length < directoriesAt) return null;
    const directoryCount = optional.readUInt32LE(directoriesAt - 4);
    const directory = (index) =>
      index < directoryCount && directoriesAt + index * 8 + 8 <= optional.length
        ? optional.readUInt32LE(directoriesAt + index * 8)
        : 0;

    const table = await readAt(handle, pe + 24 + optionalSize, sectionCount * 40);
    if (table.length < sectionCount * 40) throw new Error(`Truncated PE section table: ${file}`);
    const sections = Array.from({ length: sectionCount }, (_, index) => ({
      address: table.readUInt32LE(index * 40 + 12),
      size: Math.max(table.readUInt32LE(index * 40 + 8), table.readUInt32LE(index * 40 + 16)),
      raw: table.readUInt32LE(index * 40 + 20),
    }));
    const offsetOf = (rva) => {
      const section = sections.find((s) => rva >= s.address && rva < s.address + s.size);
      return section ? rva - section.address + section.raw : -1;
    };

    const names = [];
    // Import descriptors are 20 bytes with the name RVA at 12; delay-load
    // descriptors are 32 bytes with it at 4. Both lists end in an all-zero entry.
    async function collect(rva, size, nameAt) {
      if (!rva) return;
      for (let index = 0; index < MAX_DESCRIPTORS; index++) {
        const offset = offsetOf(rva + index * size);
        if (offset < 0) return;
        const entry = await readAt(handle, offset, size);
        if (entry.length < size || entry.every((byte) => byte === 0)) return;
        const nameOffset = offsetOf(entry.readUInt32LE(nameAt));
        if (nameOffset < 0) throw new Error(`Unreadable PE import name: ${file}`);
        const bytes = await readAt(handle, nameOffset, 260);
        const end = bytes.indexOf(0);
        names.push(bytes.subarray(0, end < 0 ? bytes.length : end).toString('latin1'));
      }
      throw new Error(`Too many PE import descriptors: ${file}`);
    }
    await collect(directory(1), 20, 12);
    await collect(directory(13), 32, 4);
    return names;
  } finally {
    await handle.close();
  }
}

async function* packageFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* packageFiles(file);
    else if (entry.isFile()) yield file;
  }
}

/**
 * Throw when any binary under `appOutDir` imports a Visual C++ runtime DLL that
 * `runtimeDir` does not contain. An unstaged runtime (local builds without
 * Visual Studio) is skipped unless the build requires one.
 */
async function verifyVcRuntimeCoverage({ appOutDir, runtimeDir, required = false }) {
  let staged;
  try {
    staged = new Set((await readdir(runtimeDir)).map((name) => name.toLowerCase()));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    staged = new Set();
  }
  if (staged.size === 0) {
    if (required) throw new Error('No Visual C++ runtime was staged for this Windows package.');
    return { binariesChecked: 0, skipped: true };
  }
  const runtime = path.resolve(runtimeDir).toLowerCase();
  const missing = new Map();
  let binariesChecked = 0;
  for await (const file of packageFiles(appOutDir)) {
    if (!PE_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    if (path.dirname(path.resolve(file)).toLowerCase() === runtime) continue;
    const imports = await peImports(file);
    if (!imports) continue;
    binariesChecked++;
    for (const name of imports) {
      const dll = name.toLowerCase();
      if (!VC_RUNTIME_DLL.test(dll) || staged.has(dll)) continue;
      missing.set(dll, [...(missing.get(dll) ?? []), path.relative(appOutDir, file)]);
    }
  }
  if (missing.size > 0) {
    const details = [...missing]
      .map(([dll, importers]) => `${dll} (imported by ${importers.join(', ')})`)
      .join('; ');
    throw new Error(
      `The staged Visual C++ runtime is missing ${details}. Add it to stage-vc-runtime.cjs.`,
    );
  }
  return { binariesChecked, skipped: false };
}

module.exports = { peImports, verifyVcRuntimeCoverage, VC_RUNTIME_DLL };
