export type { WorkspaceDescriptor, TransientOrigin } from './types.js';
export {
  WORKSPACE_BACKUP_LIMITS,
  WORKSPACE_BACKUP_MANIFEST,
  appendWorkspaceBackup,
  finishWorkspaceBackup,
  parseWorkspaceBackupManifest,
  readWorkspaceBackup,
  restoreWorkspaceBackup,
  type BackupWorkspace,
  type WorkspaceBackupManifest,
  type RestorableWorkspace,
} from './backup.js';
export { parsePersistedWorkspaceList } from './workspace-schema.js';

export {
  DEFAULT_WORKSPACE_ID,
  listWorkspaces,
  getWorkspace,
  saveWorkspace,
  removeWorkspace,
  touchWorkspace,
  ensureDefaultWorkspace,
  registerTransientWorkspace,
  getTransientWorkspace,
  unregisterTransientWorkspace,
} from './workspace-manager.js';
export {
  reconcileElectronWorkspaceDescriptors,
  type ElectronWorkspaceReconciliation,
} from './reconcile-electron.js';
