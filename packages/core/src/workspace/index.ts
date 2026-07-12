export type { WorkspaceDescriptor, TransientOrigin } from './types.js';

export {
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
