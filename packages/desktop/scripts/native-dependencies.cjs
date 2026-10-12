/**
 * Cross-packaging must not reuse npm's host-only optional native packages.
 * Stage the target variants from the governed lockfile into a separate fileset;
 * never change the developer's node_modules or regenerate dependency versions.
 */
const { createRequire } = require('node:module');
const { mkdir, readFile, readdir, rm } = require('node:fs/promises');
const path = require('node:path');

const families = [
  '@napi-rs/canvas',
  '@napi-rs/keyring',
  '@resvg/resvg-js',
  '@vscode/ripgrep',
  'sqlite-vec',
];
const repoRoot = path.resolve(__dirname, '../../..');

function matches(values, value) {
  if (!values) return true;
  return (
    !values.includes(`!${value}`) &&
    (!values.some((item) => !item.startsWith('!')) || values.includes(value))
  );
}

function supportsTarget(manifest, platform, arch) {
  return (
    matches(manifest.os, platform) &&
    matches(manifest.cpu, arch) &&
    (platform !== 'linux' || matches(manifest.libc, 'glibc'))
  );
}

function selectNativePackages(lock, platform, arch) {
  if (!['win32', 'linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Unsupported desktop native dependency target: ${platform}-${arch}`);
  }
  const selected = [];
  for (const family of families) {
    const parent = lock.packages[`node_modules/${family}`];
    if (!parent?.optionalDependencies) throw new Error(`Missing locked native family: ${family}`);
    const variants = [];
    for (const [name, version] of Object.entries(parent.optionalDependencies)) {
      const entry = lock.packages[`node_modules/${name}`];
      if (!entry || entry.version !== version || !entry.os || !entry.cpu) {
        throw new Error(`Missing exact platform package in lockfile: ${name}@${version}`);
      }
      // Older N-API package manifests omit libc; Electron's Linux builds use glibc.
      if (!supportsTarget(entry, platform, arch) || name.endsWith('-musl')) continue;
      if (
        !/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved ?? '') ||
        !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? '')
      ) {
        throw new Error(`Native package requires a registry URL and SHA-512 lock pin: ${name}`);
      }
      if (entry.hasInstallScript || entry.dependencies || entry.optionalDependencies) {
        throw new Error(`Native variant is no longer a self-contained prebuilt package: ${name}`);
      }
      variants.push({ name, ...entry });
    }
    // sqlite-vec has no Windows ARM64 binary. Gezel catches its unsupported-platform
    // error and runs without that optional acceleration. Never ship its x64 DLL.
    if (
      variants.length !== 1 &&
      !(
        family === 'sqlite-vec' &&
        platform === 'win32' &&
        arch === 'arm64' &&
        variants.length === 0
      )
    ) {
      throw new Error(
        `Expected one ${family} variant for ${platform}-${arch}; found ${variants.length}`,
      );
    }
    selected.push(...variants);
  }
  return selected;
}

function nativeArchitecture(bytes) {
  if (bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ') {
    const pe = bytes.readUInt32LE(0x3c);
    if (pe + 6 <= bytes.length && bytes.toString('ascii', pe, pe + 4) === 'PE\0\0') {
      return {
        platform: 'win32',
        arch: { 0x8664: 'x64', 0xaa64: 'arm64' }[bytes.readUInt16LE(pe + 4)],
      };
    }
  }
  if (bytes.length >= 20 && bytes.toString('hex', 0, 4) === '7f454c46' && bytes[5] === 1) {
    return { platform: 'linux', arch: { 62: 'x64', 183: 'arm64' }[bytes.readUInt16LE(18)] };
  }
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf) {
    return {
      platform: 'darwin',
      arch: { 0x1000007: 'x64', 0x100000c: 'arm64' }[bytes.readUInt32LE(4)],
    };
  }
  return null;
}

function requireArchitecture(bytes, filename, platform, arch) {
  const actual = nativeArchitecture(bytes);
  if (!actual || actual.platform !== platform || actual.arch !== arch) {
    throw new Error(
      `Wrong native architecture: ${filename}; expected ${platform}-${arch}, found ${actual ? `${actual.platform}-${actual.arch ?? 'unknown'}` : 'unknown binary'}`,
    );
  }
}

function isNativeFile(filename) {
  return /\.(node|dll|dylib|so)$/.test(filename) || /\/bin\/rg(?:\.exe)?$/.test(filename);
}

async function walkFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory())
      files.push(...(await walkFiles(path.join(directory, entry.name), relative + '/')));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unexpected native package link or special file: ${relative}`);
  }
  return files;
}

async function stageNativeDependencies({ appDir, platform, arch, lock, extract }) {
  lock ??= JSON.parse(await readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const selected = selectNativePackages(lock, platform, arch);
  // Use pacote supplied by our exact-pinned npm toolchain: it verifies SRI on
  // cached and downloaded tarballs and safely extracts them without lifecycle scripts.
  extract ??= createRequire(require.resolve('npm/package.json'))('pacote').extract;
  const stagingRoot = path.join(appDir, 'dist', 'native-modules');
  const os = { win32: 'win', darwin: 'mac', linux: 'linux' }[platform];
  const destination = path.join(stagingRoot, `${os}-${arch}`);
  // Only our target-specific generated directory is removed; builds for the other
  // architecture and the installed dependency tree are independent.
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const entry of selected) {
    const packageDir = path.join(destination, 'node_modules', entry.name);
    await extract(entry.resolved, packageDir, {
      integrity: entry.integrity,
      cache: path.join(appDir, 'dist', 'native-module-cache'),
      ignoreScripts: true,
      timeout: 120000,
    });
    const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
    if (
      manifest.name !== entry.name ||
      manifest.version !== entry.version ||
      !supportsTarget(manifest, platform, arch)
    ) {
      throw new Error(`Staged native package does not match its lock pin/target: ${entry.name}`);
    }
    const binaries = (await walkFiles(packageDir)).filter((file) =>
      isNativeFile(`${entry.name}/${file}`),
    );
    if (binaries.length === 0) throw new Error(`Native package has no binary: ${entry.name}`);
    for (const file of binaries)
      requireArchitecture(
        await readFile(path.join(packageDir, file)),
        `${entry.name}/${file}`,
        platform,
        arch,
      );
  }
  return selected.map((entry) => entry.name);
}

/** Verify the final ASAR, including actual unpacked bytes, before code signing. */
async function verifyNativeDependencies({ asarPath, platform, arch, lock }) {
  const asar = require('@electron/asar');
  asar.uncache(asarPath);
  const extract = (file) => asar.extractFile(asarPath, path.normalize(file));
  lock ??= JSON.parse(await readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const expected = selectNativePackages(lock, platform, arch);
  const entries = asar
    .listPackage(asarPath)
    .map((file) => file.replaceAll('\\', '/').replace(/^\//, ''));
  const fileSet = new Set(entries);
  const requiredPrefixes = new Map();
  for (const family of families) {
    const manifest = JSON.parse(extract(`node_modules/${family}/package.json`).toString());
    if (manifest.version !== lock.packages[`node_modules/${family}`].version) {
      throw new Error(`Packaged native loader differs from lock: ${family}`);
    }
  }
  for (const entry of expected) {
    const prefix = `node_modules/${entry.name}/`;
    const manifestPath = prefix + 'package.json';
    if (!fileSet.has(manifestPath))
      throw new Error(`Packaged native dependency is missing: ${entry.name}`);
    const manifest = JSON.parse(extract(manifestPath).toString());
    if (
      manifest.version !== entry.version ||
      manifest.name !== entry.name ||
      !supportsTarget(manifest, platform, arch)
    ) {
      throw new Error(`Packaged native dependency differs from target/lock: ${entry.name}`);
    }
    requiredPrefixes.set(prefix, 0);
  }
  for (const file of entries) {
    if (file.endsWith('/package.json')) {
      const manifest = JSON.parse(extract(file).toString());
      if (!supportsTarget(manifest, platform, arch))
        throw new Error(`Foreign platform package in ASAR: ${file}`);
      const family = families.find((name) => manifest.name?.startsWith(`${name}-`));
      if (
        family &&
        !expected.some(
          (entry) => entry.name === manifest.name && entry.version === manifest.version,
        )
      ) {
        throw new Error(`Unexpected native variant in ASAR: ${file}`);
      }
    }
  }
  let checked = 0;
  for (const file of entries) {
    const prefix = [...requiredPrefixes.keys()].find((item) => file.startsWith(item));
    if (!file.endsWith('.node') && !(prefix && isNativeFile(file))) continue;
    const info = asar.statFile(asarPath, path.normalize(file));
    if (!info.unpacked) throw new Error(`Native binary must be unpacked: ${file}`);
    requireArchitecture(
      await readFile(path.join(asarPath + '.unpacked', file)),
      file,
      platform,
      arch,
    );
    if (prefix) requiredPrefixes.set(prefix, requiredPrefixes.get(prefix) + 1);
    checked++;
  }
  for (const [prefix, count] of requiredPrefixes) {
    if (count === 0) throw new Error(`Packaged native dependency has no binary: ${prefix}`);
  }
  return {
    platform,
    arch,
    packages: expected.map((entry) => entry.name),
    binariesChecked: checked,
  };
}

module.exports = {
  selectNativePackages,
  stageNativeDependencies,
  verifyNativeDependencies,
  nativeArchitecture,
};
