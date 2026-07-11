/**
 * Preload script — exposes the typed DocBlocksHost API to the renderer
 * via contextBridge. No raw ipcRenderer leaks to the renderer.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  DocBlocksHostAPI,
  DocBlocksHostFsAPI,
  DocBlocksHostFsV2API,
  DocBlocksHostExternalAPI,
  DocBlocksHostGitAPI,
  DocBlocksHostLifecycleAPI,
  DocBlocksHostShellAPI,
  DocBlocksHostExportAPI,
  DocBlocksHostWorkspacesAPI,
  DocBlocksHostFfmpegAPI,
  DocBlocksHostUpdaterAPI,
  ElectronWorkspaceInfo,
  GitCloneProgress,
  GitResult,
  GitStatus,
  HostPrepareCloseRequest,
  HostPrepareCloseResult,
  HostEnvironment,
  HostFileSystemV2WatchMessage,
  MenuCommand,
  OpenRequest,
  UpdaterStatus,
} from '@bendyline/docblocks/host';
import type { FileSystemEntry, FileMeta } from '@bendyline/docblocks/filesystem';

// ── fs ──────────────────────────────────────────────────────────────

const fsApi: DocBlocksHostFsAPI = {
  readFile: (rootPath, p) => ipcRenderer.invoke('fs:readFile', rootPath, p),
  writeFile: (rootPath, p, content) => ipcRenderer.invoke('fs:writeFile', rootPath, p, content),
  commitFile: (rootPath, p, content, expectedContent) =>
    ipcRenderer.invoke('fs:commitFile', rootPath, p, content, expectedContent),
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
    let listening = true;
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { subscriptionId: string; path: string },
    ) => {
      if (payload.subscriptionId === subscriptionId) onChange(payload.path);
    };
    const stopListening = () => {
      if (!listening) return;
      listening = false;
      ipcRenderer.removeListener('fs:watch:event', listener);
    };
    ipcRenderer.on('fs:watch:event', listener);
    const subscribed = ipcRenderer.invoke('fs:watch:subscribe', rootPath, subscriptionId);
    void subscribed.catch(stopListening);
    return () => {
      stopListening();
      void subscribed
        .then(() => ipcRenderer.invoke('fs:watch:unsubscribe', rootPath, subscriptionId))
        .catch(() => undefined);
    };
  },
};

const fsV2Api: DocBlocksHostFsV2API = {
  open: (request) => ipcRenderer.invoke('fs:v2:open', request),
  stat: (instanceId, p) => ipcRenderer.invoke('fs:v2:stat', instanceId, p),
  readFile: (instanceId, p) => ipcRenderer.invoke('fs:v2:readFile', instanceId, p),
  readDirectory: (instanceId, p) => ipcRenderer.invoke('fs:v2:readDirectory', instanceId, p),
  writeFile: (instanceId, p, data, options) =>
    ipcRenderer.invoke('fs:v2:writeFile', instanceId, p, data, options),
  createDirectory: (instanceId, p, options) =>
    ipcRenderer.invoke('fs:v2:createDirectory', instanceId, p, options),
  remove: (instanceId, p, options) => ipcRenderer.invoke('fs:v2:remove', instanceId, p, options),
  move: (instanceId, oldPath, newPath, options) =>
    ipcRenderer.invoke('fs:v2:move', instanceId, oldPath, newPath, options),
  snapshot: (instanceId) => ipcRenderer.invoke('fs:v2:snapshot', instanceId),
  watchSubscribe: (instanceId, subscriptionId) =>
    ipcRenderer.invoke('fs:v2:watchSubscribe', instanceId, subscriptionId),
  watchUnsubscribe: (instanceId, subscriptionId) =>
    ipcRenderer.invoke('fs:v2:watchUnsubscribe', instanceId, subscriptionId),
  dispose: (instanceId) => ipcRenderer.invoke('fs:v2:dispose', instanceId),
  onWatchMessage(listener) {
    const handler = (_event: Electron.IpcRendererEvent, message: HostFileSystemV2WatchMessage) =>
      listener(message);
    ipcRenderer.on('fs:v2:watchMessage', handler);
    return () => ipcRenderer.removeListener('fs:v2:watchMessage', handler);
  },
};

// ── external (single OS-opened files) ───────────────────────────────

const externalApi: DocBlocksHostExternalAPI = {
  readText: (p) => ipcRenderer.invoke('external:readText', p) as Promise<string | null>,
  readBinary: (p) => ipcRenderer.invoke('external:readBinary', p) as Promise<ArrayBuffer | null>,
  writeText: (p, content) => ipcRenderer.invoke('external:writeText', p, content),
  writeBinary: (p, data) => ipcRenderer.invoke('external:writeBinary', p, data),
  commitText: (p, content, expectedContent) =>
    ipcRenderer.invoke('external:commitText', p, content, expectedContent),
  commitBinary: (p, data, expectedVersion) =>
    ipcRenderer.invoke('external:commitBinary', p, data, expectedVersion),
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

let prepareCloseListener:
  | ((request: HostPrepareCloseRequest) => Promise<HostPrepareCloseResult>)
  | null = null;
const cancelCloseListeners = new Set<(requestId: string) => void>();

ipcRenderer.on(
  'lifecycle:prepare-close',
  async (_event: Electron.IpcRendererEvent, request: HostPrepareCloseRequest) => {
    let result: HostPrepareCloseResult;
    if (!prepareCloseListener) {
      result = {
        status: 'blocked',
        code: 'not-ready',
        message: 'The document session is not ready.',
      };
    } else {
      try {
        result = await prepareCloseListener(request);
      } catch (error: unknown) {
        result = {
          status: 'blocked',
          code: 'save-failed',
          message: error instanceof Error ? error.message : 'Could not save the document.',
        };
      }
    }
    ipcRenderer.send('lifecycle:prepare-close-result', {
      requestId: request.requestId,
      result,
    });
  },
);

ipcRenderer.on('lifecycle:cancel-close', (_event: Electron.IpcRendererEvent, requestId: string) => {
  for (const listener of [...cancelCloseListeners]) listener(requestId);
});

const lifecycleApi: DocBlocksHostLifecycleAPI = {
  onPrepareClose(listener) {
    prepareCloseListener = listener;
    return () => {
      if (prepareCloseListener === listener) prepareCloseListener = null;
    };
  },
  onCancelClose(listener) {
    cancelCloseListeners.add(listener);
    return () => cancelCloseListeners.delete(listener);
  },
};

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
  fsV2: fsV2Api,
  external: externalApi,
  workspaces: workspacesApi,
  shell: shellApi,
  exports: exportApi,
  ffmpeg: ffmpegApi,
  git: gitApi,
  updater: updaterApi,
  lifecycle: lifecycleApi,
  onMenuCommand,
  onOpenRequest,
};

contextBridge.exposeInMainWorld('docBlocksHost', host);
