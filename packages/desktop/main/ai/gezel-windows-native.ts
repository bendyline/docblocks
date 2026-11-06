import { readFile } from 'node:fs/promises';
import path from 'node:path';

type VerifyNativeBinaries = typeof import('@bendyline/gezel-inference').verifyNativeBinaries;
export type NativeFileManifest = NonNullable<Parameters<VerifyNativeBinaries>[0]['manifest']>;

/**
 * Packaging removes uv.exe from Windows engines (stage-gezel-native.cjs), and
 * Gezel's verifier rejects any difference from its pinned file set, so those
 * payloads are checked against the same pins less that one file.
 */
export function withoutWindowsUv(manifest: NativeFileManifest): NativeFileManifest {
  return {
    ...manifest,
    platforms: Object.fromEntries(
      Object.entries(manifest.platforms).map(([key, platform]) => [
        key,
        key.startsWith('win32-')
          ? {
              ...platform,
              files: Object.fromEntries(
                Object.entries(platform.files).filter(([file]) => file !== 'uv.exe'),
              ),
            }
          : platform,
      ]),
    ),
  };
}

/** Read from Gezel's own package: a manifest beside the app is never trusted. */
export async function windowsNativeManifest(
  resolve: (id: string) => string = (id) => require.resolve(id),
): Promise<NativeFileManifest> {
  const root = path.dirname(resolve('@bendyline/gezel-inference/package.json'));
  const file = path.join(root, 'dist', 'engines', 'native-file-manifest.json');
  return withoutWindowsUv(JSON.parse(await readFile(file, 'utf8')) as NativeFileManifest);
}
