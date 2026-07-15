import {
  getFileSystemProviderV2,
  type FileSystemFileSnapshot,
  type FileSystemProvider,
  type FileSystemSnapshotFile,
  type WorkspacePath,
} from '@bendyline/docblocks/filesystem';

function pathDepth(path: WorkspacePath): number {
  return path ? path.split('/').length : 0;
}

/**
 * Copy a complete transient workspace tree into an existing workspace root.
 *
 * Every destination entry is created with no-replace semantics. If a write
 * fails after creation begins, files are removed only while their versions
 * still match the versions created here, followed by now-empty directories.
 * The caller owns closing the transient workspace after its document session
 * has transitioned to the returned destination tree.
 */
export async function copyTransientWorkspaceContents(
  source: FileSystemProvider,
  destination: FileSystemProvider,
): Promise<void> {
  const sourceV2 = getFileSystemProviderV2(source);
  const destinationV2 = getFileSystemProviderV2(destination);
  if (!sourceV2 || !destinationV2) {
    throw new Error('Moving a temporary document requires a current workspace provider.');
  }

  const snapshot = await sourceV2.snapshot();
  const entries = snapshot.entries.filter((entry) => entry.path !== '');
  if (entries.length === 0) {
    throw new Error('The temporary workspace does not contain anything to move.');
  }

  // Preflight the complete snapshot before making the first mutation. A DBK
  // can contain a Markdown file plus several companion directories; none of
  // those entries may merge with or replace destination content implicitly.
  for (const entry of entries) {
    if ((await destinationV2.stat(entry.path)) !== null) {
      throw new Error(
        `“${entry.path}” already exists in ${destination.label}. Rename or move it, then try again.`,
      );
    }
  }

  const directories = entries
    .filter((entry) => entry.kind === 'directory')
    .sort((left, right) => pathDepth(left.path) - pathDepth(right.path));
  const files = entries
    .filter((entry): entry is FileSystemSnapshotFile => entry.kind === 'file')
    .sort((left, right) => left.path.localeCompare(right.path));
  const createdDirectories: WorkspacePath[] = [];
  const createdFiles: FileSystemFileSnapshot[] = [];

  try {
    for (const directory of directories) {
      await destinationV2.createDirectory(directory.path, {
        mode: 'create',
        createParents: false,
      });
      createdDirectories.push(directory.path);
    }
    for (const file of files) {
      const created = await destinationV2.writeFile(file.path, file.data, {
        mode: 'create',
        createParents: false,
        expectedVersion: null,
      });
      createdFiles.push(created);
    }
  } catch (error: unknown) {
    // A changed file is no longer ours to remove. Empty-directory removal is
    // deliberately non-recursive so a concurrent addition is preserved.
    for (const file of [...createdFiles].reverse()) {
      try {
        await destinationV2.remove(file.path, {
          missing: 'ignore',
          expectedVersion: file.version,
        });
      } catch {
        // Best-effort rollback cannot overwrite the original failure.
      }
    }
    for (const path of [...createdDirectories].reverse()) {
      try {
        const current = await destinationV2.stat(path);
        if (current?.kind !== 'directory') continue;
        await destinationV2.remove(path, {
          recursive: false,
          missing: 'ignore',
          expectedVersion: current.version,
        });
      } catch {
        // Preserve a non-empty or concurrently changed directory.
      }
    }
    throw error;
  }
}
