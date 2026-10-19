import type { ContentContainer } from '@bendyline/squisq/storage';
import type { FileSystemProviderV2 } from '../filesystem/v2.js';
import { parseWorkspacePath, type WorkspacePath } from '../filesystem/workspace-path.js';

export const WORKSPACE_BACKUP_MANIFEST = 'docblocks-backup.json';
export const WORKSPACE_BACKUP_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxUncompressedBytes: 128 * 1024 * 1024,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 1_000,
});

export interface BackupWorkspace {
  readonly name: string;
  readonly prefix: string;
  readonly directories: readonly WorkspacePath[];
}

export interface WorkspaceBackupManifest {
  readonly format: 'docblocks-workspace-backup';
  readonly version: 1;
  readonly workspaces: readonly BackupWorkspace[];
}

export interface RestorableWorkspace {
  readonly name: string;
  readonly directories: readonly WorkspacePath[];
  readonly files: readonly { path: WorkspacePath; data: ArrayBuffer }[];
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid workspace backup metadata.');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) {
    throw new Error('Unrecognized workspace backup metadata fields.');
  }
  return record;
}

function entryPath(value: unknown): WorkspacePath {
  if (typeof value !== 'string' || value.length > 4_096)
    throw new Error('Invalid backup entry path.');
  const path = parseWorkspacePath(value);
  if (!path || path !== value)
    throw new Error('Backup entries must have canonical relative paths.');
  return path;
}

export function parseWorkspaceBackupManifest(value: unknown): WorkspaceBackupManifest {
  const record = exactRecord(value, ['format', 'version', 'workspaces']);
  if (record.format !== 'docblocks-workspace-backup' || record.version !== 1) {
    throw new Error('This workspace backup version is not supported.');
  }
  if (
    !Array.isArray(record.workspaces) ||
    !record.workspaces.length ||
    record.workspaces.length > 100
  ) {
    throw new Error('A backup must contain between 1 and 100 workspaces.');
  }
  let directoryCount = 0;
  const workspaces = record.workspaces.map((value, index): BackupWorkspace => {
    const workspace = exactRecord(value, ['name', 'prefix', 'directories']);
    if (
      typeof workspace.name !== 'string' ||
      !workspace.name.trim() ||
      workspace.name.length > 1_024
    ) {
      throw new Error('Invalid backup workspace name.');
    }
    if (workspace.prefix !== `workspaces/${index + 1}` || !Array.isArray(workspace.directories)) {
      throw new Error('Invalid backup workspace location.');
    }
    directoryCount += workspace.directories.length;
    if (directoryCount > WORKSPACE_BACKUP_LIMITS.maxEntries)
      throw new Error('Too many backup directories.');
    const directories = workspace.directories.map(entryPath);
    if (new Set(directories).size !== directories.length)
      throw new Error('Duplicate backup directories.');
    return { name: workspace.name, prefix: workspace.prefix, directories };
  });
  return { format: 'docblocks-workspace-backup', version: 1, workspaces };
}

/** Capture bytes and empty directories without modifying the source workspace. */
export async function appendWorkspaceBackup(
  container: ContentContainer,
  provider: FileSystemProviderV2,
  previous: readonly BackupWorkspace[],
): Promise<BackupWorkspace[]> {
  const snapshot = await provider.snapshot();
  const workspace: BackupWorkspace = {
    name: provider.label || 'Workspace',
    prefix: `workspaces/${previous.length + 1}`,
    directories: snapshot.entries
      .filter((entry) => entry.kind === 'directory' && entry.path !== '')
      .map((entry) => entry.path),
  };
  const workspaces = [...previous, workspace];
  parseWorkspaceBackupManifest({ format: 'docblocks-workspace-backup', version: 1, workspaces });
  for (const entry of snapshot.entries) {
    if (entry.kind === 'file') {
      entryPath(entry.path);
      if (entry.data.byteLength > WORKSPACE_BACKUP_LIMITS.maxEntryUncompressedBytes) {
        throw new Error(`Backup file exceeds the 64 MiB restore limit: ${entry.path}`);
      }
      await container.writeFile(`${workspace.prefix}/${entry.path}`, entry.data);
    }
  }
  return workspaces;
}

export async function finishWorkspaceBackup(
  container: ContentContainer,
  workspaces: readonly BackupWorkspace[],
): Promise<void> {
  const manifest = parseWorkspaceBackupManifest({
    format: 'docblocks-workspace-backup',
    version: 1,
    workspaces,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  if (bytes.byteLength > 1024 * 1024) throw new Error('Workspace backup metadata is too large.');
  await container.writeFile(WORKSPACE_BACKUP_MANIFEST, bytes);
  // Apply the same bounds as restore so the app never offers an unusable backup.
  await readWorkspaceBackup(container, 'Workspace');
}

/** Validate the complete archive before creating any destination workspace.
 * Legacy plain ZIP backups restore as one workspace, retaining their full tree.
 */
export async function readWorkspaceBackup(
  container: ContentContainer,
  legacyName: string,
): Promise<RestorableWorkspace[]> {
  const entries = await container.listFiles();
  if (entries.length > WORKSPACE_BACKUP_LIMITS.maxEntries)
    throw new Error('Too many backup files.');
  const paths = entries.map((entry) => entryPath(entry.path));
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate backup files.');
  // ZIP writers also emit the implied parent directories. Count those here
  // so an archive we create cannot exceed the bounded ZIP reader's budget.
  const archiveEntries = new Set<string>(paths);
  for (const path of paths) {
    const parts = path.split('/');
    while (parts.length > 1) {
      parts.pop();
      archiveEntries.add(`${parts.join('/')}/`);
    }
  }
  if (archiveEntries.size > WORKSPACE_BACKUP_LIMITS.maxEntries)
    throw new Error('Too many backup entries.');
  const metadata = paths.includes(parseWorkspacePath(WORKSPACE_BACKUP_MANIFEST))
    ? await container.readFile(WORKSPACE_BACKUP_MANIFEST)
    : null;
  if (metadata && metadata.byteLength > 1024 * 1024)
    throw new Error('Workspace backup metadata is too large.');
  const manifest = metadata
    ? parseWorkspaceBackupManifest(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata)),
      )
    : null;
  const workspaces = manifest?.workspaces ?? [{ name: legacyName, prefix: '', directories: [] }];
  if (
    paths.length +
      workspaces.reduce((count, workspace) => count + workspace.directories.length, 0) >
    WORKSPACE_BACKUP_LIMITS.maxEntries
  ) {
    throw new Error('Too many backup files and directories.');
  }
  const result = workspaces.map((workspace) => ({
    ...workspace,
    files: [] as { path: WorkspacePath; data: ArrayBuffer }[],
  }));
  let total = metadata?.byteLength ?? 0;
  for (const path of paths) {
    if (manifest && path === WORKSPACE_BACKUP_MANIFEST) continue;
    const index = manifest
      ? workspaces.findIndex((workspace) => path.startsWith(`${workspace.prefix}/`))
      : 0;
    if (index < 0) throw new Error(`Backup file is outside its workspace: ${path}`);
    const relative = entryPath(manifest ? path.slice(workspaces[index].prefix.length + 1) : path);
    const data = await container.readFile(path);
    if (!data) throw new Error(`Backup file is missing: ${path}`);
    total += data.byteLength;
    if (
      data.byteLength > WORKSPACE_BACKUP_LIMITS.maxEntryUncompressedBytes ||
      total > WORKSPACE_BACKUP_LIMITS.maxUncompressedBytes
    ) {
      throw new Error('Workspace backup exceeds the restore size limits.');
    }
    result[index].files.push({ path: relative, data });
  }
  for (const workspace of result) {
    const files = new Set(workspace.files.map((file) => file.path));
    for (const path of [...workspace.directories, ...files]) {
      if (workspace.directories.includes(path) && files.has(path))
        throw new Error(`Conflicting backup entry: ${path}`);
      const parts = path.split('/');
      while (parts.length > 1) {
        parts.pop();
        if (files.has(parseWorkspacePath(parts.join('/'))))
          throw new Error(`Backup file is also a parent directory: ${path}`);
      }
    }
  }
  return result;
}

/** Only an empty, newly allocated destination may receive a restored tree. */
export async function restoreWorkspaceBackup(
  workspace: RestorableWorkspace,
  provider: FileSystemProviderV2,
): Promise<void> {
  if ((await provider.readDirectory(parseWorkspacePath(''))).length)
    throw new Error('Restore requires a new, empty workspace.');
  for (const path of workspace.directories)
    await provider.createDirectory(path, { createParents: true });
  for (const file of workspace.files) {
    await provider.writeFile(file.path, file.data, {
      mode: 'create',
      createParents: true,
      expectedVersion: null,
    });
  }
}
