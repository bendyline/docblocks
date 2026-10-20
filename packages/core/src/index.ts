/**
 * @bendyline/docblocks — Core package
 *
 * Re-exports filesystem, document, workspace, and host modules for convenience.
 */

export * from './filesystem/index.js';
export * from './document/index.js';
// Keep the original root API stable. Workspace backup APIs are available
// through the workspace entry point without expanding every root consumer.
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
  parsePersistedWorkspaceList,
  reconcileElectronWorkspaceDescriptors,
  type WorkspaceDescriptor,
  type TransientOrigin,
  type ElectronWorkspaceReconciliation,
} from './workspace/index.js';
export * from './host/index.js';
export * from './share/index.js';
