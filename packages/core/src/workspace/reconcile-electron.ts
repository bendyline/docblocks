import type { ElectronWorkspaceInfo, HostEnvironment } from '../host/types.js';
import type { WorkspaceDescriptor } from './types.js';

export interface ElectronWorkspaceReconciliation {
  /** Obsolete renderer descriptors to remove before attempting restoration. */
  readonly removeIds: readonly string[];
  /** Canonical main-authorized descriptors to insert or replace. */
  readonly upsert: readonly WorkspaceDescriptor[];
  /** Safe navigation migration for a local descriptor matched by root. */
  readonly idRemap: Readonly<Record<string, string>>;
}

function comparableRoot(rootPath: string, platform: HostEnvironment['platform']): string {
  const normalized = rootPath.replace(/\\/gu, '/').replace(/\/+$/gu, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Reconcile renderer IndexedDB metadata with the main process authority list.
 * `hostWorkspaces` is authoritative: local Electron descriptors absent from
 * it cannot be opened safely and are removed. Root-path matching carries user
 * metadata across an id migration without treating that display path as
 * authority.
 */
export function reconcileElectronWorkspaceDescriptors(
  local: readonly WorkspaceDescriptor[],
  hostWorkspaces: readonly ElectronWorkspaceInfo[],
  platform: HostEnvironment['platform'],
  now: string,
): ElectronWorkspaceReconciliation {
  const electron = local.filter((workspace) => workspace.type === 'electron-native');
  const matchedLocalIds = new Set<string>();
  const idRemap: Record<string, string> = {};
  const upsert = hostWorkspaces.map((hostWorkspace): WorkspaceDescriptor => {
    const root = comparableRoot(hostWorkspace.rootPath, platform);
    const candidates = electron.filter(
      (workspace) => workspace.rootPath && comparableRoot(workspace.rootPath, platform) === root,
    );
    const matching = candidates.sort((left, right) =>
      right.lastOpened.localeCompare(left.lastOpened),
    )[0];
    if (matching) {
      matchedLocalIds.add(matching.id);
      if (matching.id !== hostWorkspace.id) idRemap[matching.id] = hostWorkspace.id;
    }
    return {
      id: hostWorkspace.id,
      name: matching?.name ?? hostWorkspace.name,
      type: 'electron-native',
      rootPath: hostWorkspace.rootPath,
      lastOpened: matching?.lastOpened ?? now,
      ...(matching?.versioningOverride ? { versioningOverride: matching.versioningOverride } : {}),
    };
  });
  const canonicalIds = new Set(hostWorkspaces.map((workspace) => workspace.id));
  const removeIds = electron
    .filter(
      (workspace) =>
        !canonicalIds.has(workspace.id) ||
        (matchedLocalIds.has(workspace.id) &&
          !upsert.some((candidate) => candidate.id === workspace.id)),
    )
    .map((workspace) => workspace.id);
  return { removeIds, upsert, idRemap };
}
