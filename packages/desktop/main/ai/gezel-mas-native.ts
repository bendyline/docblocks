import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

interface MasNativeFile {
  bundlePath: string;
  kind: 'executable' | 'library';
  sha256: string;
  sizeBytes: number;
}
interface MasNativeManifest {
  schemaVersion: 3;
  release: string;
  files: Record<string, MasNativeFile>;
  symlinks: Record<string, string>;
}
const run = promisify(execFile);
const STORE_CERTIFICATE = 'certificate leaf[field.1.2.840.113635.100.6.1.9] exists';
const SIGNING_REQUIREMENT = `=anchor apple generic and (certificate leaf[subject.OU] = "5B7Y53BF56" or certificate leaf[subject.OU] = "JXA5M4VK3V" or ${STORE_CERTIFICATE})`;
const COMMAND_OPTIONS = { timeout: 60_000, maxBuffer: 1024 * 1024 };
const REQUIRED = [
  'darwin-arm64/gezel-apple-fm',
  'darwin-arm64/uv',
  'darwin-arm64-metal/gezel-llama-server',
];
const MAX_FILE = 2 * 1024 ** 3;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
function logicalPath(value: string): boolean {
  return (
    /^(?:darwin-arm64|darwin-arm64-metal)\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value) &&
    !['__proto__', 'constructor', 'prototype'].includes(path.posix.basename(value))
  );
}
function location(logical: string, kind: MasNativeFile['kind']): string {
  return `Contents/${kind === 'executable' ? 'Helpers' : 'Frameworks'}/${path.posix.basename(logical)}`;
}
function appForRoot(root: string): string {
  const suffix = path.join('Contents', 'Resources', 'gezel-native');
  if (!root.endsWith(path.sep + suffix))
    throw new Error('MAS engines must be inside app resources.');
  const app = root.slice(0, -suffix.length - 1);
  if (!app.endsWith('.app')) throw new Error('MAS engines have no enclosing app.');
  return app;
}

/** codesign emits XML on older macOS and an abstract DER view on newer macOS. */
export function hasMasSandboxInheritance(source: string): boolean {
  const expected = ['com.apple.security.app-sandbox', 'com.apple.security.inherit'];
  const lines = source
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim());
  if (lines[0] === '[Dict]') {
    return (
      lines.length === 7 &&
      expected.every((key) => lines.filter((line) => line === `[Key] ${key}`).length === 1) &&
      [1, 4].every(
        (index) =>
          expected.some((key) => lines[index] === `[Key] ${key}`) &&
          lines[index + 1] === '[Value]' &&
          lines[index + 2] === '[Bool] true',
      )
    );
  }
  const keys = [...source.matchAll(/<key>([^<]+)<\/key>/gu)].map((match) => match[1]);
  return (
    source.includes('<plist') &&
    keys.length === 2 &&
    expected.every((key) =>
      new RegExp(`<key>${key.replaceAll('.', '\\.')}</key>\\s*<true\\s*/>`).test(source),
    )
  );
}

/** Accepted only after the enclosing app authenticates its complete resource seal. */
export function parseMasNativeManifest(value: unknown, release: string): MasNativeManifest {
  if (
    !record(value) ||
    !exact(value, ['schemaVersion', 'release', 'files', 'symlinks']) ||
    value.schemaVersion !== 3 ||
    value.release !== release ||
    !record(value.files) ||
    !record(value.symlinks) ||
    Object.keys(value.files).length + Object.keys(value.symlinks).length > 10_000
  )
    throw new Error('Invalid MAS native manifest.');
  const files: MasNativeManifest['files'] = {};
  const symlinks: Record<string, string> = {};
  const destinations = new Set<string>();
  for (const [logical, pin] of Object.entries(value.files)) {
    if (
      !logicalPath(logical) ||
      !record(pin) ||
      !exact(pin, ['bundlePath', 'kind', 'sha256', 'sizeBytes']) ||
      (pin.kind !== 'executable' && pin.kind !== 'library') ||
      pin.bundlePath !== location(logical, pin.kind) ||
      (pin.kind === 'executable'
        ? !REQUIRED.includes(logical)
        : !logical.startsWith('darwin-arm64-metal/') || !/\.(?:dylib|so)$/u.test(logical)) ||
      typeof pin.sha256 !== 'string' ||
      !/^[a-f\d]{64}$/u.test(pin.sha256) ||
      typeof pin.sizeBytes !== 'number' ||
      !Number.isSafeInteger(pin.sizeBytes) ||
      pin.sizeBytes <= 0 ||
      pin.sizeBytes > MAX_FILE ||
      destinations.has(pin.bundlePath)
    )
      throw new Error('Invalid MAS native file pin.');
    destinations.add(pin.bundlePath);
    files[logical] = {
      bundlePath: pin.bundlePath,
      kind: pin.kind,
      sha256: pin.sha256,
      sizeBytes: pin.sizeBytes,
    };
  }
  for (const [logical, target] of Object.entries(value.symlinks)) {
    if (!logicalPath(logical) || typeof target !== 'string' || target.length > 1024)
      throw new Error('Invalid MAS native symlink.');
    const file = files[logical];
    const expected = file
      ? path.posix.relative(
          `Contents/Resources/gezel-native/${path.posix.dirname(logical)}`,
          file.bundlePath,
        )
      : null;
    if (
      file
        ? target !== expected
        : !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(target) ||
          !logical.startsWith('darwin-arm64-metal/')
    )
      throw new Error('Invalid MAS native symlink target.');
    symlinks[logical] = target;
  }
  if (
    REQUIRED.some((logical) => files[logical]?.kind !== 'executable') ||
    Object.keys(files).some((logical) => !Object.hasOwn(symlinks, logical))
  )
    throw new Error('MAS native manifest is missing Apple, UV or Metal inference.');
  return { schemaVersion: 3, release, files, symlinks };
}

export async function verifyMasNativeFiles(
  root: string,
  manifest: MasNativeManifest,
  options: {
    verifySeal: () => Promise<unknown>;
    verifySignature: (file: string, kind: MasNativeFile['kind']) => Promise<unknown>;
    deliveredByStore: boolean;
  },
): Promise<void> {
  const app = appForRoot(root);
  await options.verifySeal();
  if ((await realpath(root)) !== path.resolve(root))
    throw new Error('MAS native root must not be a symlink.');
  const links: Record<string, string> = {};
  let entries = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 10_000) throw new Error('MAS native payload exceeds entry limits.');
      const file = path.join(directory, entry.name);
      const logical = path.relative(root, file).split(path.sep).join('/');
      if (entry.isSymbolicLink()) links[logical] = await readlink(file);
      else if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const info = await lstat(file);
        if ((info.mode & 0o111) !== 0 || /\.(?:dylib|so)$/u.test(entry.name))
          throw new Error('Unexpected native code in MAS resources.');
      } else throw new Error('Unsupported MAS native resource.');
    }
  }
  await visit(root);
  if (
    !exact(links, Object.keys(manifest.symlinks)) ||
    Object.entries(links).some(([key, target]) => target !== manifest.symlinks[key])
  )
    throw new Error('MAS native symlink set changed.');
  const observations: Array<{ file: string; info: Awaited<ReturnType<typeof lstat>> }> = [];
  for (const [logical, pin] of Object.entries(manifest.files)) {
    const file = path.join(app, pin.bundlePath);
    if (
      (await realpath(file)) !== path.resolve(file) ||
      (await realpath(path.join(root, logical))) !== file
    )
      throw new Error('MAS native code has an invalid location.');
    if (pin.kind === 'library' && logical.endsWith('.so')) {
      const name = path.posix.basename(logical);
      const plugin = path.join(app, 'Contents', 'Helpers', name);
      if ((await readlink(plugin)) !== `../Frameworks/${name}` || (await realpath(plugin)) !== file)
        throw new Error('MAS native plugin link changed.');
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size <= 0 || info.size > MAX_FILE)
        throw new Error('Invalid MAS native file.');
      let bytes = 0;
      const digest = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        bytes += chunk.length;
        if (bytes > info.size) throw new Error('MAS native file changed during verification.');
        digest.update(chunk);
      }
      const sha256 = digest.digest('hex');
      if (
        bytes !== info.size ||
        (!options.deliveredByStore && (bytes !== pin.sizeBytes || sha256 !== pin.sha256))
      )
        throw new Error('MAS native hash mismatch.');
      await options.verifySignature(file, pin.kind);
      observations.push({ file, info });
    } finally {
      await handle.close();
    }
  }
  for (const logical of Object.keys(links)) {
    if (manifest.files[logical]) continue;
    const resolved = await realpath(path.join(root, logical));
    const target = Object.values(manifest.files).find(
      (pin) => pin.kind === 'library' && path.join(app, pin.bundlePath) === resolved,
    );
    if (!target) throw new Error('MAS alias does not terminate at a pinned library.');
    const alias = path.join(app, 'Contents', 'Frameworks', path.posix.basename(logical));
    if ((await readlink(alias)) !== links[logical] || (await realpath(alias)) !== resolved)
      throw new Error('MAS Frameworks alias changed.');
  }
  // Apple re-signs delivered code. Only its authenticated complete seal
  // permits changed byte hashes; local builds keep the exact recorded pins.
  await options.verifySeal();
  for (const { file, info } of observations) {
    const current = await lstat(file);
    if (
      !current.isFile() ||
      current.dev !== info.dev ||
      current.ino !== info.ino ||
      current.size !== info.size ||
      current.mtimeMs !== info.mtimeMs ||
      current.ctimeMs !== info.ctimeMs
    )
      throw new Error('MAS native file changed during resource authentication.');
  }
}

export async function verifyMasNativePayload(root: string): Promise<{ reused: true }> {
  const app = appForRoot(root);
  const requirement = `${SIGNING_REQUIREMENT} and identifier "com.bendyline.docblocks"`;
  const verifyApp = () =>
    run(
      '/usr/bin/codesign',
      ['--verify', '--deep', '--strict', '-R', requirement, app],
      COMMAND_OPTIONS,
    );
  await verifyApp();
  const manifestPath = path.join(root, 'mas-manifest.json');
  const handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source: string;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > 1024 * 1024)
      throw new Error('Invalid MAS native manifest file.');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('Incomplete MAS manifest.');
      offset += bytesRead;
    }
    await verifyApp();
    const current = await lstat(manifestPath);
    const held = await handle.stat();
    if (
      [current, held].some(
        (stat) =>
          !stat.isFile() ||
          stat.dev !== info.dev ||
          stat.ino !== info.ino ||
          stat.size !== info.size ||
          stat.mtimeMs !== info.mtimeMs ||
          stat.ctimeMs !== info.ctimeMs,
      )
    )
      throw new Error('MAS manifest changed during authentication.');
    source = bytes.toString('utf8');
  } finally {
    await handle.close();
  }
  const pins = await import('@bendyline/gezel-service/native-release');
  const value: unknown = JSON.parse(source);
  const manifest = parseMasNativeManifest(value, pins.NATIVE_ENGINE_RELEASE);
  const verifyStoreSeal = () =>
    run(
      '/usr/bin/codesign',
      [
        '--verify',
        '--deep',
        '--strict',
        '-R',
        `=anchor apple generic and ${STORE_CERTIFICATE} and identifier "com.bendyline.docblocks"`,
        app,
      ],
      COMMAND_OPTIONS,
    );
  let deliveredByStore = false;
  try {
    await verifyStoreSeal();
    deliveredByStore = true;
  } catch (error) {
    // codesign exits 3 for a valid signature that fails a test requirement.
    // Other failures must not downgrade store authentication to local mode.
    if (!record(error) || error.code !== 3) throw error;
  }
  await verifyMasNativeFiles(root, manifest, {
    deliveredByStore,
    verifySeal: deliveredByStore ? verifyStoreSeal : verifyApp,
    verifySignature: async (file, kind) => {
      await run(
        '/usr/bin/codesign',
        ['--verify', '--strict', '-R', SIGNING_REQUIREMENT, file],
        COMMAND_OPTIONS,
      );
      if (kind === 'executable') {
        const { stdout } = await run(
          '/usr/bin/codesign',
          ['-d', '--entitlements', '-', file],
          COMMAND_OPTIONS,
        );
        if (!hasMasSandboxInheritance(stdout))
          throw new Error('Native executable must inherit the app sandbox.');
      }
    },
  });
  return { reused: true };
}
