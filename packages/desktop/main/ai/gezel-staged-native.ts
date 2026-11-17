import { lstat, readFile, readlink, stat } from 'node:fs/promises';
import path from 'node:path';

type VerifyNativeBinaries = typeof import('@bendyline/gezel-inference').verifyNativeBinaries;
export type NativeFileManifest = NonNullable<Parameters<VerifyNativeBinaries>[0]['manifest']>;

/** UV as Gezel's engine archives name it: `uv.exe` on Windows, `uv` elsewhere. */
const UV_FILES: ReadonlySet<string> = new Set(['uv', 'uv.exe']);

/**
 * Packaging removes UV from the engines it stages (stage-gezel-native.cjs), so
 * those payloads are checked against the same pins less that one file.
 */
export function withoutUv(manifest: NativeFileManifest): NativeFileManifest {
  return {
    ...manifest,
    platforms: Object.fromEntries(
      Object.entries(manifest.platforms).map(([key, platform]) => [
        key,
        Object.keys(platform.files).some((file) => UV_FILES.has(file))
          ? {
              ...platform,
              files: Object.fromEntries(
                Object.entries(platform.files).filter(([file]) => !UV_FILES.has(file)),
              ),
            }
          : platform,
      ]),
    ),
  };
}

/** Read from Gezel's own package: a manifest beside the app is never trusted. */
export async function pinnedNativeManifest(
  resolve: (id: string) => string = (id) => require.resolve(id),
): Promise<NativeFileManifest> {
  const root = path.dirname(resolve('@bendyline/gezel-inference/package.json'));
  const file = path.join(root, 'dist', 'engines', 'native-file-manifest.json');
  return JSON.parse(await readFile(file, 'utf8')) as NativeFileManifest;
}

/** Gezel's pins for a payload DocBlocks staged itself, which has no UV. */
export async function stagedNativeManifest(
  resolve?: (id: string) => string,
): Promise<NativeFileManifest> {
  return withoutUv(await pinnedNativeManifest(resolve));
}

export interface NativePayloadCheck {
  /** The release this build's Gezel expects; engines from another may reject its flags. */
  readonly release: string;
  /** Pinned sizes and symlinks for every engine published for this platform. */
  readonly manifest?: NativeFileManifest;
  /**
   * Files that must exist at any size. Apple re-signs the code in a store app,
   * which changes its sizes, so a Mac App Store payload is checked this way.
   */
  readonly executables?: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The startup check for engines that ship inside DocBlocks: the release this
 * build expects is present and complete. It is deliberately not a hash or
 * signature check. The operating system's code signing protects the installed
 * app, and a check that lives inside the same app could not add to it. Hashes
 * and signatures are verified when the payload is staged and packaged.
 * Throws a log-only explanation on the first problem it finds.
 */
export async function checkNativePayload(root: string, check: NativePayloadCheck): Promise<void> {
  const { platform = process.platform, arch = process.arch } = check;
  let staged: unknown;
  try {
    staged = JSON.parse(await readFile(path.join(root, 'release.json'), 'utf8'));
  } catch (error) {
    throw new Error(
      `release.json is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const release = record(staged) && typeof staged.release === 'string' ? staged.release : null;
  if (release !== check.release)
    throw new Error(
      `engines are release ${release ?? 'unknown'}; this build needs ${check.release}`,
    );
  for (const file of check.executables ?? []) {
    const info = await stat(path.join(root, ...file.split('/'))).catch(() => null);
    if (!info?.isFile() || info.size === 0) throw new Error(`missing: ${file}`);
  }
  if (!check.manifest) return;
  const base = `${platform}-${arch}`;
  const entries = Object.entries(check.manifest.platforms).filter(
    ([key]) => key === base || key.startsWith(`${base}-`),
  );
  if (entries.length === 0) throw new Error(`no engines are pinned for ${base}`);
  for (const [key, pins] of entries) {
    for (const [file, pin] of Object.entries(pins.files)) {
      const info = await lstat(path.join(root, key, ...file.split('/'))).catch(() => null);
      if (!info?.isFile()) throw new Error(`missing: ${key}/${file}`);
      if (info.size !== pin.sizeBytes) throw new Error(`size mismatch: ${key}/${file}`);
    }
    for (const [link, target] of Object.entries(pins.symlinks)) {
      const actual = await readlink(path.join(root, key, ...link.split('/'))).catch(() => null);
      if (actual !== target) throw new Error(`symlink changed: ${key}/${link}`);
    }
  }
}
