export type { WorkspaceDescriptor } from './types.js';

export {
  listWorkspaces,
  getWorkspace,
  saveWorkspace,
  removeWorkspace,
  touchWorkspace,
  ensureDefaultWorkspace,
} from './workspace-manager.js';
