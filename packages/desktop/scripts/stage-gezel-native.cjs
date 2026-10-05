/**
 * electron-builder beforePack hook. The installed service, never "latest",
 * supplies the native release and archive SHA-256 pins. Downloads happen only
 * on the build machine; runtime checks the service's per-file pins as well.
 */
const { createHash } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} = require('node:fs/promises');
const { createRequire } = require('node:module');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const {
  clearTimeout: clearDownloadTimeout,
  setTimeout: setDownloadTimeout,
} = require('node:timers');

const MAX_ARCHIVE_BYTES = 2 * 1024 ** 3;
const MAX_EXTRACTED_BYTES = 8 * 1024 ** 3;
const MAX_ENTRIES = 10000;

function selectArchives(pins, platform, arch) {
  if (!/^\d+\.\d+\.\d+$/.test(pins.NATIVE_ENGINE_RELEASE)) {
    throw new Error('Gezel must pin an exact native release.');
  }
  const prefix = `gezel-native-${pins.NATIVE_ENGINE_RELEASE}-${platform}-${arch}`;
  const extension = platform === 'win32' ? '.zip' : '.tar.gz';
  return Object.entries(pins.NATIVE_ENGINE_ARCHIVE_SHA256)
    .filter(
      ([name]) =>
        name === `${prefix}${extension}` ||
        (name.startsWith(`${prefix}-`) && name.endsWith(extension)),
    )
    .map(([name, sha256]) => {
      if (!/^[a-z\d.-]+$/.test(name) || !/^[a-f\d]{64}$/i.test(sha256) || /^0{64}$/.test(sha256)) {
        throw new Error(`Invalid Gezel native archive pin: ${name}`);
      }
      return {
        name,
        sha256: sha256.toLowerCase(),
        platformKey: name.slice(
          `gezel-native-${pins.NATIVE_ENGINE_RELEASE}-`.length,
          -extension.length,
        ),
      };
    });
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifiedArchive(file, pin, fetchImpl) {
  try {
    if ((await stat(file)).size <= MAX_ARCHIVE_BYTES && (await hashFile(file)) === pin.sha256)
      return;
    throw new Error(`Cached Gezel archive failed SHA-256 verification: ${pin.name}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${file}.partial`;
  const controller = new AbortController();
  const timeout = setDownloadTimeout(() => controller.abort(), 10 * 60 * 1000);
  timeout.unref();
  try {
    const version = pin.name.match(/^gezel-native-(\d+\.\d+\.\d+)-/)[1];
    const response = await fetchImpl(
      `https://github.com/bendyline/gezel/releases/download/native-v${version}/${pin.name}`,
      { signal: controller.signal },
    );
    if (!response.ok || !response.body)
      throw new Error(`Could not download ${pin.name}: HTTP ${response.status}`);
    let bytes = 0;
    const hash = createHash('sha256');
    const guard = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_ARCHIVE_BYTES)
          return callback(new Error(`Gezel archive too large: ${pin.name}`));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      guard,
      createWriteStream(temporary, { flags: 'wx' }),
    );
    if (hash.digest('hex') !== pin.sha256)
      throw new Error(`Gezel archive SHA-256 mismatch: ${pin.name}`);
    await rename(temporary, file);
  } finally {
    clearDownloadTimeout(timeout);
    await rm(temporary, { force: true });
  }
}

function checkEntry(name, size, budget) {
  const parts = name.replace(/^\.\//, '').replace(/\/$/, '').split('/');
  if (
    name !== './' &&
    name !== '.' &&
    parts.some((part) => !part || part === '..' || part === '.' || unsafeSegment(part))
  ) {
    throw new Error(`Unsafe Gezel archive path: ${name}`);
  }
  budget.entries += 1;
  budget.bytes += size;
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    budget.entries > MAX_ENTRIES ||
    budget.bytes > MAX_EXTRACTED_BYTES
  ) {
    throw new Error('Gezel archive exceeds extraction limits.');
  }
}

function unsafeSegment(value) {
  return /[\\:]/.test(value) || [...value].some((character) => character.charCodeAt(0) < 32);
}

async function extractArchive(file, target, serviceRequire) {
  await mkdir(target, { recursive: true });
  const budget = { entries: 0, bytes: 0 };
  if (file.endsWith('.zip')) {
    const AdmZip = serviceRequire('adm-zip');
    const zip = new AdmZip(file);
    for (const entry of zip.getEntries()) {
      checkEntry(entry.entryName, entry.header.size, budget);
      if (((entry.header.attr >>> 16) & 0o170000) === 0o120000) {
        throw new Error('Symlinks are not supported in Windows Gezel archives.');
      }
    }
    zip.extractAllTo(target, false);
  } else {
    const tar = serviceRequire('tar');
    const links = new Map();
    const files = new Set();
    // Inspect the complete verified archive before writing any of its entries.
    await tar.t({
      file,
      strict: true,
      onReadEntry(entry) {
        checkEntry(entry.path, entry.size, budget);
        if (!['File', 'Directory', 'SymbolicLink'].includes(entry.type)) {
          throw new Error(`Unsupported Gezel archive entry: ${entry.type}`);
        }
        if (
          entry.type === 'SymbolicLink' &&
          (!entry.linkpath ||
            entry.linkpath.split('/').some((part) => !part || part === '..' || unsafeSegment(part)))
        ) {
          throw new Error(`Unsafe Gezel archive symlink: ${entry.path}`);
        }
        const name = entry.path.replace(/^\.\//, '');
        if (entry.type === 'File') files.add(name);
        if (entry.type === 'SymbolicLink') links.set(name, entry.linkpath);
      },
    });
    // Extract regular files first so no archive entry can be written through
    // a previously created link. Then restore the release's SONAME chains.
    await tar.x({
      file,
      cwd: target,
      strict: true,
      preservePaths: false,
      filter: (_name, entry) => entry.type !== 'SymbolicLink',
    });
    for (const [name, linkTarget] of links) {
      let resolved = name;
      const seen = new Set();
      while (links.has(resolved)) {
        if (seen.has(resolved)) throw new Error(`Cyclic Gezel archive symlink: ${name}`);
        seen.add(resolved);
        resolved = path.posix.join(path.posix.dirname(resolved), links.get(resolved));
      }
      if (!files.has(resolved))
        throw new Error(`Gezel archive symlink has no regular target: ${name}`);
      await symlink(linkTarget, path.join(target, name), 'file');
    }
  }
}

async function stageNative({
  pins,
  platform,
  arch,
  destination,
  cache,
  serviceRequire,
  fetchImpl = fetch,
  allowUnavailable = false,
}) {
  const archives = selectArchives(pins, platform, arch);
  if (!archives.length && !allowUnavailable) {
    throw new Error(`The pinned Gezel release has no native archives for ${platform}/${arch}.`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(destination), '.gezel-staging-'));
  try {
    for (const pin of archives) {
      process.stdout.write(
        `Staging Gezel ${pin.platformKey} (native-v${pins.NATIVE_ENGINE_RELEASE})\n`,
      );
      const file = path.join(cache, pin.name);
      await verifiedArchive(file, pin, fetchImpl);
      await extractArchive(file, path.join(staging, pin.platformKey), serviceRequire);
    }
    if (platform === 'darwin' && archives.length && !pins.NATIVE_ENGINE_MACOS_NOTARIZED) {
      throw new Error('The pinned Gezel macOS native release must be notarized.');
    }
    await writeFile(
      path.join(staging, 'release.json'),
      JSON.stringify(
        {
          release: pins.NATIVE_ENGINE_RELEASE,
          platform,
          arch,
          archives: archives.map(({ name, sha256 }) => ({ name, sha256 })),
        },
        null,
        2,
      ) + '\n',
    );
    // A fresh tree prevents stale libraries from a previous pin surviving.
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return archives;
}

async function stageForTarget(context, overrides = {}) {
  const appDir = context.packager.info.appDir;
  const platform = context.electronPlatformName === 'mas' ? 'darwin' : context.electronPlatformName;
  const arch = require('builder-util').Arch[context.arch];
  const pins = overrides.pins ?? (await import('@bendyline/gezel-service/native-release'));
  const serviceRequire = createRequire(require.resolve('@bendyline/gezel-service/package.json'));
  const manifest = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8'));
  const installed = serviceRequire('./package.json');
  if (manifest.dependencies['@bendyline/gezel-service'] !== installed.version) {
    throw new Error("The installed Gezel service must match DocBlocks' exact dependency pin.");
  }
  await stageNative({
    pins,
    platform,
    arch,
    serviceRequire,
    destination: path.join(
      appDir,
      'dist',
      'gezel-native',
      `${context.packager.platform.buildConfigurationKey}-${arch}`,
    ),
    cache: path.join(appDir, 'dist', 'gezel-native-cache'),
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  });
}

exports.default = (context) => stageForTarget(context);
exports.stageForTarget = stageForTarget;

exports.selectArchives = selectArchives;
exports.stageNative = stageNative;
exports.checkEntry = checkEntry;
