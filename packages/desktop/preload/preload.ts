/**
 * Preload script — exposes the typed DocBlocksHost API to the renderer
 * via contextBridge. No raw ipcRenderer leaks to the renderer.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { parseOpenRequest } from '@bendyline/docblocks/host';
import type {
  DocBlocksHostAPI,
  DocBlocksHostFsAPI,
  DocBlocksHostFsV2API,
  DocBlocksHostExternalAPI,
  DocBlocksHostGitAPI,
  DocBlocksHostLifecycleAPI,
  DocBlocksHostShellAPI,
  DocBlocksHostClipboardAPI,
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
  DocBlocksHostMenuAPI,
  HostEnvironment,
  HostFileSystemV2WatchMessage,
  MenuCommand,
  OpenRequest,
  UpdaterStatus,
} from '@bendyline/docblocks/host';
import type { FileSystemEntry, FileMeta } from '@bendyline/docblocks/filesystem';
import { BufferedEventChannel } from './buffered-event-channel.js';
import { parseHostEnvironmentArguments } from '../shared/host-environment.js';

// The main process can dispatch launch argv as soon as the BrowserWindow is
// ready-to-show, before React effects subscribe. Install this preload listener
// immediately and bridge a bounded backlog once the renderer is ready.
const openRequestChannel = new BufferedEventChannel<OpenRequest>(
  32,
  () => undefined,
  (request) => {
    if (request.kind === 'external-file' || request.kind === 'external-bundle') {
      // A bounded preload backlog can discard an old navigation request. Its
      // opaque main-side capability must not outlive the request that owned it.
      void ipcRenderer.invoke('external:revoke', request.resourceId).catch(() => undefined);
    }
  },
);
ipcRenderer.on('open-request', (_event, value: unknown) => {
  const request = parseOpenRequest(value);
  if (request) openRequestChannel.publish(request);
});

// ── fs ──────────────────────────────────────────────────────────────

const fsApi: DocBlocksHostFsAPI = {
  readFile: (workspaceId, p) => ipcRenderer.invoke('fs:readFile', workspaceId, p),
  writeFile: (workspaceId, p, content) =>
    ipcRenderer.invoke('fs:writeFile', workspaceId, p, content),
  commitFile: (workspaceId, p, content, expectedContent) =>
    ipcRenderer.invoke('fs:commitFile', workspaceId, p, content, expectedContent),
  delete: (workspaceId, p) => ipcRenderer.invoke('fs:delete', workspaceId, p),
  rename: (workspaceId, o, n) => ipcRenderer.invoke('fs:rename', workspaceId, o, n),
  readDirectory: (workspaceId, p) =>
    ipcRenderer.invoke('fs:readDirectory', workspaceId, p) as Promise<FileSystemEntry[]>,
  exists: (workspaceId, p) => ipcRenderer.invoke('fs:exists', workspaceId, p),
  createDirectory: (workspaceId, p) => ipcRenderer.invoke('fs:createDirectory', workspaceId, p),
  stat: (workspaceId, p) =>
    ipcRenderer.invoke('fs:stat', workspaceId, p) as Promise<FileMeta | null>,
  readBinary: (workspaceId, p) =>
    ipcRenderer.invoke('fs:readBinary', workspaceId, p) as Promise<ArrayBuffer | null>,
  writeBinary: (workspaceId, p, data) => ipcRenderer.invoke('fs:writeBinary', workspaceId, p, data),
  watch(workspaceId, onChange) {
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
    const subscribed = ipcRenderer.invoke('fs:watch:subscribe', workspaceId, subscriptionId);
    void subscribed.catch(stopListening);
    return () => {
      stopListening();
      void subscribed
        .then(() => ipcRenderer.invoke('fs:watch:unsubscribe', workspaceId, subscriptionId))
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
  readText: (resourceId) =>
    ipcRenderer.invoke('external:readText', resourceId) as Promise<string | null>,
  readBinary: (resourceId) =>
    ipcRenderer.invoke('external:readBinary', resourceId) as Promise<ArrayBuffer | null>,
  writeText: (resourceId, content) => ipcRenderer.invoke('external:writeText', resourceId, content),
  writeBinary: (resourceId, data) => ipcRenderer.invoke('external:writeBinary', resourceId, data),
  commitText: (resourceId, content, expectedContent) =>
    ipcRenderer.invoke('external:commitText', resourceId, content, expectedContent),
  commitBinary: (resourceId, data, expectedVersion) =>
    ipcRenderer.invoke('external:commitBinary', resourceId, data, expectedVersion),
  revoke: (resourceId) => ipcRenderer.invoke('external:revoke', resourceId),
};

// ── workspaces ──────────────────────────────────────────────────────

const workspacesApi: DocBlocksHostWorkspacesAPI = {
  list: () => ipcRenderer.invoke('workspaces:list') as Promise<ElectronWorkspaceInfo[]>,
  getDefault: () => ipcRenderer.invoke('workspaces:getDefault') as Promise<ElectronWorkspaceInfo>,
  pickFolder: () =>
    ipcRenderer.invoke('workspaces:pickFolder') as Promise<ElectronWorkspaceInfo | null>,
  register: (workspaceId) => ipcRenderer.invoke('workspaces:register', workspaceId),
  unregister: (id) => ipcRenderer.invoke('workspaces:unregister', id),
};

// ── shell ───────────────────────────────────────────────────────────

const shellApi: DocBlocksHostShellAPI = {
  revealInFolder: (workspaceId, workspacePath) =>
    ipcRenderer.invoke('shell:revealInFolder', workspaceId, workspacePath ?? ''),
  openWorkspaceFolder: (workspaceId) =>
    ipcRenderer.invoke('shell:openWorkspaceFolder', workspaceId),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
};

const clipboardApi: DocBlocksHostClipboardAPI = {
  writeText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  writeWorkspacePath: (workspaceId, workspacePath) =>
    ipcRenderer.invoke('clipboard:writeWorkspacePath', workspaceId, workspacePath),
};

// â”€â”€ exports â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const exportApi: DocBlocksHostExportAPI = {
  resolveTarget: (documentId, filename) =>
    ipcRenderer.invoke('exports:resolveTarget', documentId, filename),
  pickTarget: (documentId, filename, currentGrantId) =>
    ipcRenderer.invoke('exports:pickTarget', documentId, filename, currentGrantId ?? null),
  save: (documentId, filename, grantId, data) =>
    ipcRenderer.invoke('exports:save', documentId, filename, grantId, data),
};

// ── ffmpeg ──────────────────────────────────────────────────────────

const ffmpegApi: DocBlocksHostFfmpegAPI = {
  available: () => ipcRenderer.invoke('ffmpeg:available'),
  version: () => ipcRenderer.invoke('ffmpeg:version'),
};

// ── git ─────────────────────────────────────────────────────────────

function mintId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const gitApi: DocBlocksHostGitAPI = {
  capabilities: () => ipcRenderer.invoke('git:capabilities'),
  detectRepo: (workspaceId) => ipcRenderer.invoke('git:detectRepo', workspaceId),
  grantExpandedRepo: (workspaceId, opts) =>
    ipcRenderer.invoke('git:grantExpandedRepo', workspaceId, opts),
  init: (workspaceId) => ipcRenderer.invoke('git:init', workspaceId),
  status: (repositoryId) => ipcRenderer.invoke('git:status', repositoryId),
  stage: (repositoryId, paths) => ipcRenderer.invoke('git:stage', repositoryId, paths),
  unstage: (repositoryId, paths) => ipcRenderer.invoke('git:unstage', repositoryId, paths),
  discard: (repositoryId, paths) => ipcRenderer.invoke('git:discard', repositoryId, paths),
  commit: (repositoryId, message, paths) =>
    ipcRenderer.invoke('git:commit', repositoryId, message, paths),
  push: (repositoryId, opts) => ipcRenderer.invoke('git:push', repositoryId, opts),
  pull: (repositoryId) => ipcRenderer.invoke('git:pull', repositoryId),
  fetch: (repositoryId) => ipcRenderer.invoke('git:fetch', repositoryId),
  listBranches: (repositoryId) => ipcRenderer.invoke('git:listBranches', repositoryId),
  createBranch: (repositoryId, name, opts) =>
    ipcRenderer.invoke('git:createBranch', repositoryId, name, opts),
  checkoutBranch: (repositoryId, name) =>
    ipcRenderer.invoke('git:checkoutBranch', repositoryId, name),
  log: (repositoryId, opts) => ipcRenderer.invoke('git:log', repositoryId, opts),
  commitFiles: (repositoryId, sha) => ipcRenderer.invoke('git:commitFiles', repositoryId, sha),
  readFileAtRevision: (repositoryId, p, revision) =>
    ipcRenderer.invoke('git:readFileAtRevision', repositoryId, p, revision),
  listRemotes: (repositoryId) => ipcRenderer.invoke('git:listRemotes', repositoryId),
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
  createPullRequest: (repositoryId) => ipcRenderer.invoke('git:createPullRequest', repositoryId),
  onStatusChanged(repositoryId, listener) {
    const subscriptionId = mintId('git-status');
    const fn = (
      _event: Electron.IpcRendererEvent,
      payload: { subscriptionId: string; status: GitStatus },
    ) => {
      if (payload.subscriptionId === subscriptionId) listener(payload.status);
    };
    ipcRenderer.on('git:status:event', fn);
    ipcRenderer.invoke('git:status:subscribe', repositoryId, subscriptionId).catch(() => undefined);
    return () => {
      ipcRenderer.removeListener('git:status:event', fn);
      ipcRenderer
        .invoke('git:status:unsubscribe', repositoryId, subscriptionId)
        .catch(() => undefined);
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
  requestWindowClose() {
    ipcRenderer.send('lifecycle:request-window-close');
  },
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
  return openRequestChannel.subscribe(listener);
}

const menuApi: DocBlocksHostMenuAPI = {
  setPinnedDocuments(documents) {
    // Send plain, structured-cloneable records. The main process re-validates
    // the payload before building any menu item — nothing here is trusted.
    ipcRenderer.send(
      'menu:setPinnedDocuments',
      documents.map((document) => ({
        workspaceId: document.workspaceId,
        workspaceName: document.workspaceName,
        path: document.path,
      })),
    );
  },
};

// ── env ─────────────────────────────────────────────────────────────

// `appVersion` and `isDev` are main-owned and arrive on argv — see
// shared/host-environment.ts. They must never be re-derived from
// `process.env` here: `npm_package_version` exists only under an `npm run`
// script and `NODE_ENV` is unset in a packaged app, so doing so reported
// version 0.0.0 and isDev:true to every user of every packaged build.
const env: HostEnvironment = {
  platform: process.platform as HostEnvironment['platform'],
  ...parseHostEnvironmentArguments(process.argv),
};

// ── expose ──────────────────────────────────────────────────────────

const host: DocBlocksHostAPI = {
  env,
  fs: fsApi,
  fsV2: fsV2Api,
  external: externalApi,
  workspaces: workspacesApi,
  shell: shellApi,
  clipboard: clipboardApi,
  exports: exportApi,
  ffmpeg: ffmpegApi,
  git: gitApi,
  updater: updaterApi,
  lifecycle: lifecycleApi,
  menu: menuApi,
  onMenuCommand,
  onOpenRequest,
};

contextBridge.exposeInMainWorld('docBlocksHost', host);
