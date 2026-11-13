import { readFile } from 'node:fs/promises';
import path from 'node:path';

type VerifyNativeBinaries = typeof import('@bendyline/gezel-inference').verifyNativeBinaries;
export type NativeFileManifest = NonNullable<Parameters<VerifyNativeBinaries>[0]['manifest']>;

/** UV as Gezel's engine archives name it: `uv.exe` on Windows, `uv` elsewhere. */
const UV_FILES: ReadonlySet<string> = new Set(['uv', 'uv.exe']);

/**
 * Packaging removes UV from the engines it stages (stage-gezel-native.cjs), and
 * Gezel's verifier rejects any difference from its pinned file set, so those
 * payloads are checked against the same pins less that one file.
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
export async function stagedNativeManifest(
  resolve: (id: string) => string = (id) => require.resolve(id),
): Promise<NativeFileManifest> {
  const root = path.dirname(resolve('@bendyline/gezel-inference/package.json'));
  const file = path.join(root, 'dist', 'engines', 'native-file-manifest.json');
  return withoutUv(JSON.parse(await readFile(file, 'utf8')) as NativeFileManifest);
}
