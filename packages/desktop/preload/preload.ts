/**
 * Preload script — exposes the typed DocblocksHost API to the renderer
 * via contextBridge. No raw ipcRenderer leaks to the renderer.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  DocblocksHostAPI,
  DocblocksHostFsAPI,
  DocblocksHostShellAPI,
  DocblocksHostWorkspacesAPI,
  DocblocksHostFfmpegAPI,
  DocblocksHostUpdaterAPI,
  ElectronWorkspaceInfo,
  HostEnvironment,
  MenuCommand,
  OpenRequest,
  UpdaterStatus,
} from '@bendyline/docblocks/host';
import type { FileSystemEntry, FileMeta } from '@bendyline/docblocks/filesystem';

// ── fs ──────────────────────────────────────────────────────────────

const fsApi: DocblocksHostFsAPI = {
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

// ── workspaces ──────────────────────────────────────────────────────

const workspacesApi: DocblocksHostWorkspacesAPI = {
  getDefault: () => ipcRenderer.invoke('workspaces:getDefault') as Promise<ElectronWorkspaceInfo>,
  pickFolder: () =>
    ipcRenderer.invoke('workspaces:pickFolder') as Promise<ElectronWorkspaceInfo | null>,
  register: (info) => ipcRenderer.invoke('workspaces:register', info),
  unregister: (id) => ipcRenderer.invoke('workspaces:unregister', id),
};

// ── shell ───────────────────────────────────────────────────────────

const shellApi: DocblocksHostShellAPI = {
  revealInFolder: (p) => ipcRenderer.invoke('shell:revealInFolder', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
};

// ── ffmpeg ──────────────────────────────────────────────────────────

const ffmpegApi: DocblocksHostFfmpegAPI = {
  available: () => ipcRenderer.invoke('ffmpeg:available'),
  version: () => ipcRenderer.invoke('ffmpeg:version'),
  renderVideo: (p, opts) => ipcRenderer.invoke('ffmpeg:renderVideo', p, opts),
};

// ── updater ─────────────────────────────────────────────────────────

const updaterApi: DocblocksHostUpdaterAPI = {
  checkForUpdates: () => ipcRenderer.invoke('updater:checkForUpdates'),
  getVersion: () => ipcRenderer.invoke('updater:getVersion'),
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

const host: DocblocksHostAPI = {
  env,
  fs: fsApi,
  workspaces: workspacesApi,
  shell: shellApi,
  ffmpeg: ffmpegApi,
  updater: updaterApi,
  onMenuCommand,
  onOpenRequest,
};

contextBridge.exposeInMainWorld('docblocksHost', host);
