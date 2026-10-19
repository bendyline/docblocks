import {
  readWorkspaceBackup,
  restoreWorkspaceBackup,
  WORKSPACE_BACKUP_LIMITS,
  saveWorkspace,
  removeWorkspace,
  type WorkspaceDescriptor,
} from '@bendyline/docblocks/workspace';
import type { FileSystemProviderV2 } from '@bendyline/docblocks/filesystem';

/** Stage a complete restore under fresh IDs, then publish it to the picker.
 * Neither malformed input nor a failed write can replace existing documents.
 */
export async function restoreBrowserBackup(file: File): Promise<WorkspaceDescriptor[]> {
  if (file.size > 256 * 1024 * 1024) throw new Error('Backup ZIPs must be smaller than 256 MiB.');
  const { zipToContainer } = await import('@bendyline/squisq-formats/container');
  const container = await zipToContainer(await file.arrayBuffer(), WORKSPACE_BACKUP_LIMITS);
  const workspaces = await readWorkspaceBackup(
    container,
    file.name.replace(/\.zip$/i, '') || 'Workspace',
  );
  const { IndexedDBFileSystemProvider, deleteIndexedDBWorkspaceData } =
    await import('@bendyline/docblocks/filesystem/indexeddb');
  const staged: { descriptor: WorkspaceDescriptor; provider: FileSystemProviderV2 }[] = [];
  try {
    for (const workspace of workspaces) {
      const descriptor: WorkspaceDescriptor = {
        id: `restored-${crypto.randomUUID()}`,
        name: `${workspace.name.slice(0, 1_013)} (restored)`,
        type: 'indexeddb',
        lastOpened: new Date().toISOString(),
      };
      const provider = new IndexedDBFileSystemProvider(descriptor.id, descriptor.name).v2;
      staged.push({ descriptor, provider });
      await restoreWorkspaceBackup(workspace, provider);
    }
    for (const { descriptor } of staged) await saveWorkspace(descriptor);
    return staged.map(({ descriptor }) => descriptor);
  } catch (error) {
    const failures: unknown[] = [error];
    for (const { descriptor, provider } of staged) {
      try {
        await provider.dispose();
        await removeWorkspace(descriptor.id);
        await deleteIndexedDBWorkspaceData(descriptor.id);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length > 1)
      throw new Error(
        `Restore failed; temporary workspace cleanup also failed. ${failures.map((failure) => (failure instanceof Error ? failure.message : String(failure))).join('; ')}`,
      );
    throw error;
  } finally {
    for (const { provider } of staged) await provider.dispose();
  }
}
