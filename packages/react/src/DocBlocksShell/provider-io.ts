/**
 * provider-io — small read/write helpers over a `FileSystemProvider` that
 * paper over the v1/v2 provider split.
 *
 * These used to be module-private to `DocBlocksShell.tsx`; they moved here so
 * `import-files.ts` can share them rather than growing a second copy of the
 * "does this provider speak v2?" branch.
 */

import {
  FsError,
  getFileSystemProviderV2,
  parseWorkspacePath,
  type FileSystemProvider,
} from '@bendyline/docblocks/filesystem';

export async function providerEntryExists(
  provider: FileSystemProvider,
  path: string,
): Promise<boolean> {
  const providerV2 = getFileSystemProviderV2(provider);
  return providerV2
    ? (await providerV2.stat(parseWorkspacePath(path))) !== null
    : provider.exists(path);
}

/**
 * Write text to `path`. `mode: 'create'` refuses to clobber an existing entry,
 * raising an `already-exists` `FsError` -- the same contract on both provider
 * generations, so callers can rely on it to protect a user's document.
 */
export async function writeProviderText(
  provider: FileSystemProvider,
  path: string,
  content: string,
  mode: 'upsert' | 'create' = 'upsert',
): Promise<void> {
  const providerV2 = getFileSystemProviderV2(provider);
  if (providerV2) {
    await providerV2.writeFile(parseWorkspacePath(path), new TextEncoder().encode(content), {
      mode,
      createParents: true,
      expectedVersion: mode === 'create' ? null : undefined,
    });
    return;
  }
  if (mode === 'create' && (await provider.exists(path))) {
    throw new FsError('already-exists', 'File already exists.', { operation: 'write', path });
  }
  await provider.writeFile(path, content);
}

export async function removeProviderEntry(
  provider: FileSystemProvider,
  path: string,
): Promise<void> {
  const providerV2 = getFileSystemProviderV2(provider);
  if (providerV2) {
    await providerV2.remove(parseWorkspacePath(path), { recursive: true, missing: 'ignore' });
    return;
  }
  await provider.delete(path);
}
