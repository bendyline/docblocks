/** Verify upstream provenance, then sign and pin the MAS copy before app signing. */
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const {
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const run = promisify(execFile);
const commandOptions = { timeout: 60000, maxBuffer: 1024 * 1024 };

async function nativeManifest(root, release) {
  const platforms = {};
  let entries = 0;
  for (const key of (await readdir(root)).sort()) {
    if (!/^darwin-arm64(?:-[a-z]+)?$/.test(key)) continue;
    const files = {};
    const symlinks = {};
    async function visit(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++entries > 10000) throw new Error('MAS native payload exceeds entry limits.');
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(path.join(root, key), absolute).split(path.sep).join('/');
        if (entry.isSymbolicLink()) symlinks[relative] = await readlink(absolute);
        else if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) {
          const info = await lstat(absolute);
          if (entry.name.endsWith('.dylib') || (info.mode & 0o111) !== 0) {
            if (info.size > 2 * 1024 ** 3) throw new Error('MAS native file exceeds size limits.');
            const digest = createHash('sha256');
            for await (const chunk of createReadStream(absolute)) digest.update(chunk);
            files[relative] = {
              sha256: digest.digest('hex'),
              sizeBytes: info.size,
              signature: 'bendyline',
            };
          }
        } else throw new Error(`Unsupported native entry: ${relative}`);
      }
    }
    const info = await lstat(path.join(root, key));
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Invalid MAS native platform root.');
    await visit(path.join(root, key));
    platforms[key] = { files, symlinks };
  }
  if (
    !platforms['darwin-arm64']?.files['gezel-apple-fm'] ||
    !platforms['darwin-arm64']?.files['uv'] ||
    !platforms['darwin-arm64-metal']?.files['gezel-llama-server']
  ) {
    throw new Error(
      'MAS requires a Gezel service pin whose native release includes gezel-apple-fm, uv and llama.cpp Metal. Publish and pin the new native release, then update the desktop Gezel service dependency.',
    );
  }
  return { schemaVersion: 2, release, platforms };
}

async function prepareMasNative({
  root,
  appDir,
  service,
  pins,
  identity,
  sign,
  relocate = relocateLlama,
}) {
  const previous = process.env.GEZEL_NATIVE_BIN_DIR;
  try {
    // The source-bundled per-file pins are checked before signatures change.
    const verified = await service.reuseVerifiedElectronNativeBinaries({
      candidates: [root],
      allowStandaloneMacPayload: true,
    });
    if (!verified.reused) throw new Error(`MAS native provenance failed: ${verified.reason}`);
  } finally {
    if (previous === undefined) delete process.env.GEZEL_NATIVE_BIN_DIR;
    else process.env.GEZEL_NATIVE_BIN_DIR = previous;
  }
  const original = await nativeManifest(root, pins.NATIVE_ENGINE_RELEASE);
  const appBundle = path.resolve(root, '../../..');
  const files = {};
  const links = {};
  const entitlements = path.join(appDir, 'entitlements.mas.inherit.plist');
  for (const [key, platform] of Object.entries(original.platforms)) {
    for (const file of Object.keys(platform.files).sort()) {
      const source = path.join(root, key, file);
      // First MAS text inference needs Apple, UV and the Metal payload.
      if (key === 'darwin-arm64' && !['gezel-apple-fm', 'uv'].includes(file)) {
        await rm(source);
        continue;
      }
      if (file !== path.basename(file))
        throw new Error('MAS native code must have flat peer names.');
      const kind = await machoKind(source);
      const bundlePath = `Contents/${kind === 'executable' ? 'Helpers' : 'Frameworks'}/${file}`;
      const destination = path.join(appBundle, bundlePath);
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        await lstat(destination);
        throw new Error(`MAS native name collision: ${file}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await rename(source, destination);
      const target = path.relative(path.dirname(source), destination).split(path.sep).join('/');
      await symlink(target, source);
      files[`${key}/${file}`] = { bundlePath, kind };
      links[`${key}/${file}`] = target;
      if (kind === 'library' && file.endsWith('.so')) {
        // ggml discovers plugins beside the executable. The code itself stays
        // in Frameworks; this also supports launching the physical helper path.
        await symlink(`../Frameworks/${file}`, path.join(appBundle, 'Contents', 'Helpers', file));
      }
    }
    for (const [file, target] of Object.entries(platform.symlinks)) {
      if (key === 'darwin-arm64') {
        await rm(path.join(root, key, file));
        continue;
      }
      if (file !== path.basename(file) || target !== path.basename(target))
        throw new Error('MAS library aliases must have flat peer names.');
      const concrete = await realpath(path.join(root, key, file));
      if (path.dirname(concrete) !== path.join(appBundle, 'Contents', 'Frameworks'))
        throw new Error('MAS alias does not name a relocated library.');
      await symlink(target, path.join(appBundle, 'Contents', 'Frameworks', file));
      links[`${key}/${file}`] = target;
    }
  }
  for (const [logical, entry] of Object.entries(files)) {
    const file = path.join(appBundle, entry.bundlePath);
    if (logical === 'darwin-arm64-metal/gezel-llama-server') await relocate(file);
    await sign(file, identity, entry.kind === 'executable' ? entitlements : null);
    const info = await lstat(file);
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    files[logical] = { ...entry, sha256: digest.digest('hex'), sizeBytes: info.size };
  }
  const manifest = {
    schemaVersion: 3,
    release: pins.NATIVE_ENGINE_RELEASE,
    files,
    symlinks: links,
  };
  // The enclosing app's signature seals this post-signing manifest. Runtime
  // authenticates that app before accepting these transformed byte pins.
  await writeFile(path.join(root, 'mas-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

async function machoKind(file) {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead !== 32 ||
      header.readUInt32LE(0) !== 0xfeedfacf ||
      header.readUInt32LE(4) !== 0x100000c
    )
      throw new Error('MAS requires ARM64 Mach-O code.');
    const type = header.readUInt32LE(12);
    if (type === 2) return 'executable';
    if (type === 6 || type === 8) return 'library';
    throw new Error('Unsupported MAS Mach-O file type.');
  } finally {
    await handle.close();
  }
}

async function relocateLlama(file) {
  await run(
    '/usr/bin/install_name_tool',
    ['-add_rpath', '@loader_path/../Frameworks', file],
    commandOptions,
  );
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'mas') return;
  const appDir = context.packager.info.appDir;
  const appName = context.packager.appInfo.productFilename;
  const root = path.join(
    context.appOutDir,
    `${appName}.app`,
    'Contents',
    'Resources',
    'gezel-native',
  );
  const pins = await import('@bendyline/gezel-service/native-release');
  await nativeManifest(root, pins.NATIVE_ENGINE_RELEASE);
  const development = context.targets.some((target) => target.name === 'mas-dev');
  const { stdout } = await run(
    '/usr/bin/security',
    ['find-identity', '-v', '-p', 'codesigning'],
    commandOptions,
  );
  const pattern = development
    ? /"((?:Apple Development|Mac Developer): [^"]+)"/g
    : /"((?:Apple Distribution|3rd Party Mac Developer Application): [^"]+)"/g;
  const identities = [...stdout.matchAll(pattern)].map((match) => match[1]);
  const requested =
    (development ? context.packager.config.masDev?.identity : undefined) ||
    context.packager.config.mas?.identity ||
    process.env.CSC_NAME;
  const matches = requested ? identities.filter((name) => name.includes(requested)) : identities;
  if (matches.length !== 1)
    throw new Error('MAS AI signing requires one matching Apple signing identity.');
  await prepareMasNative({
    root,
    appDir,
    service: await import('@bendyline/gezel-service'),
    pins,
    identity: matches[0],
    sign: async (file, identity, entitlements) => {
      await run(
        '/usr/bin/codesign',
        [
          '--force',
          '--sign',
          identity,
          '--identifier',
          `com.bendyline.docblocks.ai.${path.basename(file)}`,
          ...(entitlements ? ['--generate-entitlement-der', '--entitlements', entitlements] : []),
          file,
        ],
        commandOptions,
      );
      await run(
        '/usr/bin/codesign',
        [
          '--verify',
          '--strict',
          '-R',
          '=anchor apple generic and (certificate leaf[subject.OU] = "5B7Y53BF56" or certificate leaf[subject.OU] = "JXA5M4VK3V")',
          file,
        ],
        commandOptions,
      );
    },
  });
};
exports.prepareMasNative = prepareMasNative;
exports.nativeManifest = nativeManifest;
exports.machoKind = machoKind;
