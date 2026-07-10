/**
 * Preload script — exposes the typed DocBlocksHost API to the renderer
 * via contextBridge. No raw ipcRenderer leaks to the renderer.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  DocBlocksHostAPI,
  DocBlocksHostFsAPI,
  DocBlocksHostExternalAPI,
  DocBlocksHostGitAPI,
  DocBlocksHostShellAPI,
  DocBlocksHostExportAPI,
  DocBlocksHostWorkspacesAPI,
  DocBlocksHostFfmpegAPI,
  DocBlocksHostUpdaterAPI,
  ElectronWorkspaceInfo,
  GitCloneProgress,
  GitResult,
  GitStatus,
  HostEnvironment,
  MenuCommand,
  OpenRequest,
  UpdaterStatus,
} from '@bendyline/docblocks/host';
import type { FileSystemEntry, FileMeta } from '@bendyline/docblocks/filesystem';

// ── fs ──────────────────────────────────────────────────────────────

const fsApi: DocBlocksHostFsAPI = {
  readFile: (rootPath, p) => ipcRenderer.invoke('fs:readFile', rootPath, p),
  writeFile: (rootPath, p, content) => ipcRenderer.invoke('fs:writeFile', rootPath, p, content),
  delete: (rootPath, p) => ipcRenderer.invoke('fs:delete', rootPath, p),
  rename: (rootPath, o, n) => ipcRenderer.invoke('fs:rename', rootPath, o, n),
  readDirectory: (rootPath, p) =>
    ipcRenderer.invoke('fs:readDirectory', rootPath, p) as Promise<FileSystemEntry[]>,
  exists: (rootPath, p) => ipcRenderer.invoke('fs:exists', rootPath, p),
  createDirectory: (rootPath, p) => ipcRenderer.invoke('fs:createDirectory', rootPath, p),
  stat: (rootPath, p) => ipcRenderer.invoke('fs:stat', rootPath, p) as Promise<FileMeta | null>,
  readBinary: (rootPath, p) =>
    ipcRenderer.invoke('fs:readBinary', rootPath, p) as Promise<ArrayBuffer | null>,
  writeBinary: (rootPath, p, data) => ipcRenderer.invoke('fs:writeBinary', rootPath, p, data),
  watch(rootPath, onChange) {
    const subscriptionId = `sub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { subscriptionId: string; path: string },
    ) => {
      if (payload.subscriptionId === subscriptionId) onChange(payload.path);
    };
    ipcRenderer.on('fs:watch:event', listener);
    ipcRenderer.invoke('fs:watch:subscribe', rootPath, subscriptionId).catch(() => undefined);
    return () => {
      ipcRenderer.removeListener('fs:watch:event', listener);
      ipcRenderer.invoke('fs:watch:unsubscribe', rootPath, subscriptionId).catch(() => undefined);
    };
  },
};

// ── external (single OS-opened files) ───────────────────────────────

const externalApi: DocBlocksHostExternalAPI = {
  readText: (p) => ipcRenderer.invoke('external:readText', p) as Promise<string | null>,
  readBinary: (p) => ipcRenderer.invoke('external:readBinary', p) as Promise<ArrayBuffer | null>,
  writeText: (p, content) => ipcRenderer.invoke('external:writeText', p, content),
  writeBinary: (p, data) => ipcRenderer.invoke('external:writeBinary', p, data),
};

// ── workspaces ──────────────────────────────────────────────────────

const workspacesApi: DocBlocksHostWorkspacesAPI = {
  getDefault: () => ipcRenderer.invoke('workspaces:getDefault') as Promise<ElectronWorkspaceInfo>,
  pickFolder: () =>
    ipcRenderer.invoke('workspaces:pickFolder') as Promise<ElectronWorkspaceInfo | null>,
  register: (info) => ipcRenderer.invoke('workspaces:register', info),
  unregister: (id) => ipcRenderer.invoke('workspaces:unregister', id),
};

// ── shell ───────────────────────────────────────────────────────────

const shellApi: DocBlocksHostShellAPI = {
  revealInFolder: (p) => ipcRenderer.invoke('shell:revealInFolder', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
};

// â”€â”€ exports â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const exportApi: DocBlocksHostExportAPI = {
  resolveTarget: (documentId, filename) =>
    ipcRenderer.invoke('exports:resolveTarget', documentId, filename),
  pickTarget: (documentId, filename, currentPath) =>
    ipcRenderer.invoke('exports:pickTarget', documentId, filename, currentPath),
  save: (documentId, filename, targetPath, data) =>
    ipcRenderer.invoke('exports:save', documentId, filename, targetPath, data),
};

// ── ffmpeg ──────────────────────────────────────────────────────────

const ffmpegApi: DocBlocksHostFfmpegAPI = {
  available: () => ipcRenderer.invoke('ffmpeg:available'),
  version: () => ipcRenderer.invoke('ffmpeg:version'),
  renderVideo: (p, opts) => ipcRenderer.invoke('ffmpeg:renderVideo', p, opts),
};

// ── git ─────────────────────────────────────────────────────────────

function mintId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const gitApi: DocBlocksHostGitAPI = {
  capabilities: () => ipcRenderer.invoke('git:capabilities'),
  detectRepo: (rootPath) => ipcRenderer.invoke('git:detectRepo', rootPath),
  init: (rootPath) => ipcRenderer.invoke('git:init', rootPath),
  status: (rootPath) => ipcRenderer.invoke('git:status', rootPath),
  stage: (rootPath, paths) => ipcRenderer.invoke('git:stage', rootPath, paths),
  unstage: (rootPath, paths) => ipcRenderer.invoke('git:unstage', rootPath, paths),
  discard: (rootPath, paths) => ipcRenderer.invoke('git:discard', rootPath, paths),
  commit: (rootPath, message, paths) => ipcRenderer.invoke('git:commit', rootPath, message, paths),
  push: (rootPath, opts) => ipcRenderer.invoke('git:push', rootPath, opts),
  pull: (rootPath) => ipcRenderer.invoke('git:pull', rootPath),
  fetch: (rootPath) => ipcRenderer.invoke('git:fetch', rootPath),
  listBranches: (rootPath) => ipcRenderer.invoke('git:listBranches', rootPath),
  createBranch: (rootPath, name, opts) =>
    ipcRenderer.invoke('git:createBranch', rootPath, name, opts),
  checkoutBranch: (rootPath, name) => ipcRenderer.invoke('git:checkoutBranch', rootPath, name),
  log: (rootPath, opts) => ipcRenderer.invoke('git:log', rootPath, opts),
  commitFiles: (rootPath, sha) => ipcRenderer.invoke('git:commitFiles', rootPath, sha),
  readFileAtRevision: (rootPath, p, revision) =>
    ipcRenderer.invoke('git:readFileAtRevision', rootPath, p, revision),
  listRemotes: (rootPath) => ipcRenderer.invoke('git:listRemotes', rootPath),
  clone(url, onProgress) {
    const operationId = mintId('clone');
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: GitCloneProgress & { operationId: string },
    ) => {
      if (payload.operationId === operationId && onProgress) {
        onProgress({ phase: payload.phase, percent: payload.percent, detail: payload.detail });
      }
    };
    ipcRenderer.on('git:clone:progress', listener);
    const result = (
      ipcRenderer.invoke('git:clone', url, operationId) as Promise<
        GitResult<ElectronWorkspaceInfo | null>
      >
    ).finally(() => ipcRenderer.removeListener('git:clone:progress', listener));
    return {
      result,
      cancel: () => {
        ipcRenderer.invoke('git:clone:cancel', operationId).catch(() => undefined);
      },
    };
  },
  createPullRequest: (rootPath) => ipcRenderer.invoke('git:createPullRequest', rootPath),
  onStatusChanged(rootPath, listener) {
    const subscriptionId = mintId('git-status');
    const fn = (
      _event: Electron.IpcRendererEvent,
      payload: { subscriptionId: string; status: GitStatus },
    ) => {
      if (payload.subscriptionId === subscriptionId) listener(payload.status);
    };
    ipcRenderer.on('git:status:event', fn);
    ipcRenderer.invoke('git:status:subscribe', rootPath, subscriptionId).catch(() => undefined);
    return () => {
      ipcRenderer.removeListener('git:status:event', fn);
      ipcRenderer.invoke('git:status:unsubscribe', rootPath, subscriptionId).catch(() => undefined);
    };
  },
};

// ── updater ─────────────────────────────────────────────────────────

const updaterApi: DocBlocksHostUpdaterAPI = {
  checkForUpdates: () => ipcRenderer.invoke('updater:checkForUpdates'),
  getVersion: () => ipcRenderer.invoke('updater:getVersion'),
  quitAndInstall: () => ipcRenderer.invoke('updater:quitAndInstall'),
  onStatus(listener) {
    const fn = (_event: Electron.IpcRendererEvent, status: UpdaterStatus) => listener(status);
    ipcRenderer.on('updater:status', fn);
    return () => ipcRenderer.removeListener('updater:status', fn);
  },
};

// ── event channels ──────────────────────────────────────────────────

function onMenuCommand(listener: (cmd: MenuCommand) => void): () => void {
  const fn = (_event: Electron.IpcRendererEvent, cmd: MenuCommand) => listener(cmd);
  ipcRenderer.on('menu:command', fn);
  return () => ipcRenderer.removeListener('menu:command', fn);
}

function onOpenRequest(listener: (request: OpenRequest) => void): () => void {
  const fn = (_event: Electron.IpcRendererEvent, request: OpenRequest) => listener(request);
  ipcRenderer.on('open-request', fn);
  return () => ipcRenderer.removeListener('open-request', fn);
}

// ── env ─────────────────────────────────────────────────────────────

const env: HostEnvironment = {
  platform: process.platform as HostEnvironment['platform'],
  appVersion: process.env.npm_package_version ?? '0.0.0',
  isDev: process.env.NODE_ENV !== 'production',
};

// ── expose ──────────────────────────────────────────────────────────

const host: DocBlocksHostAPI = {
  env,
  fs: fsApi,
  external: externalApi,
  workspaces: workspacesApi,
  shell: shellApi,
  exports: exportApi,
  ffmpeg: ffmpegApi,
  git: gitApi,
  updater: updaterApi,
  onMenuCommand,
  onOpenRequest,
};

contextBridge.exposeInMainWorld('docBlocksHost', host);
