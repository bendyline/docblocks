import type { ContentContainer, ContentEntry } from '@bendyline/squisq/storage';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../src/messages.js';

type ExportBridgeResponse =
  | { type: 'exportSaved'; uri: string | null; path: string | null }
  | { type: 'exportTargetResolved'; path: string }
  | { type: 'exportTargetPicked'; path: string | null }
  | { type: 'workspaceFileRead'; dataBase64: string | null };

type ExportBridgeRequest =
  | {
      type: 'saveExport';
      filename: string;
      dataBase64: string;
      mimeType: string;
      targetPath: string | null;
    }
  | { type: 'resolveExportTarget'; filename: string }
  | { type: 'pickExportTarget'; filename: string; currentPath: string | null }
  | { type: 'readWorkspaceFile'; path: string };

interface PendingRequest {
  resolve: (response: ExportBridgeResponse) => void;
  reject: (error: Error) => void;
}

export interface VscodeExportBridge {
  saveBlob(blob: Blob, filename: string, targetPath?: string | null): Promise<string | null>;
  resolveExportTarget(filename: string): Promise<string>;
  pickExportTarget(filename: string, currentPath?: string | null): Promise<string | null>;
  contentContainer: ContentContainer;
  dispose(): void;
}

export function createVscodeExportBridge(
  postMessage: (message: WebviewToExtensionMessage) => void,
  getCurrentMarkdown: () => string | null,
  getCurrentFileName: () => string | null,
): VscodeExportBridge {
  let nextRequestId = 1;
  let disposed = false;
  const pending = new Map<number, PendingRequest>();

  function request<T extends ExportBridgeResponse>(message: ExportBridgeRequest): Promise<T> {
    const requestId = nextRequestId;
    nextRequestId += 1;

    return new Promise<T>((resolve, reject) => {
      pending.set(requestId, {
        resolve: (response) => resolve(response as T),
        reject,
      });
      postMessage({ ...message, requestId } as WebviewToExtensionMessage);
    });
  }

  function handleMessage(event: MessageEvent<ExtensionToWebviewMessage>) {
    const msg = event.data;
    switch (msg.type) {
      case 'exportSaved':
        settle(msg.requestId, { type: 'exportSaved', uri: msg.uri, path: msg.path });
        break;
      case 'exportError':
        reject(msg.requestId, new Error(msg.message));
        break;
      case 'exportTargetResolved':
        settle(msg.requestId, { type: 'exportTargetResolved', path: msg.path });
        break;
      case 'exportTargetPicked':
        settle(msg.requestId, { type: 'exportTargetPicked', path: msg.path });
        break;
      case 'workspaceFileRead':
        settle(msg.requestId, { type: 'workspaceFileRead', dataBase64: msg.dataBase64 });
        break;
      case 'workspaceFileError':
        reject(msg.requestId, new Error(msg.message));
        break;
    }
  }

  function settle(requestId: number, response: ExportBridgeResponse) {
    const pendingRequest = pending.get(requestId);
    if (!pendingRequest) return;
    pending.delete(requestId);
    pendingRequest.resolve(response);
  }

  function reject(requestId: number, error: Error) {
    const pendingRequest = pending.get(requestId);
    if (!pendingRequest) return;
    pending.delete(requestId);
    pendingRequest.reject(error);
  }

  async function readFile(path: string): Promise<ArrayBuffer | null> {
    const current = currentDocumentBuffer(path, getCurrentMarkdown, getCurrentFileName);
    if (current) return current;

    const response = await request<{ type: 'workspaceFileRead'; dataBase64: string | null }>({
      type: 'readWorkspaceFile',
      path,
    });
    return response.dataBase64 ? base64ToArrayBuffer(response.dataBase64) : null;
  }

  const contentContainer: ContentContainer = {
    readFile,

    async writeFile(): Promise<void> {
      throw new Error('VS Code export container is read-only');
    },

    async removeFile(): Promise<void> {
      throw new Error('VS Code export container is read-only');
    },

    async listFiles(_prefix?: string): Promise<ContentEntry[]> {
      return [];
    },

    async exists(path: string): Promise<boolean> {
      return (await readFile(path)) !== null;
    },

    async getDocumentPath(): Promise<string | null> {
      return getCurrentFileName();
    },

    async readDocument(): Promise<string | null> {
      return getCurrentMarkdown();
    },

    async writeDocument(): Promise<void> {
      throw new Error('VS Code export container is read-only');
    },
  };

  async function saveBlob(
    blob: Blob,
    filename: string,
    targetPath?: string | null,
  ): Promise<string | null> {
    const response = await request<{
      type: 'exportSaved';
      uri: string | null;
      path: string | null;
    }>({
      type: 'saveExport',
      filename,
      dataBase64: await blobToBase64(blob),
      mimeType: blob.type || 'application/octet-stream',
      targetPath: targetPath?.trim() ? targetPath.trim() : null,
    });
    return response.path;
  }

  async function resolveExportTarget(filename: string): Promise<string> {
    const response = await request<{ type: 'exportTargetResolved'; path: string }>({
      type: 'resolveExportTarget',
      filename,
    });
    return response.path;
  }

  async function pickExportTarget(
    filename: string,
    currentPath?: string | null,
  ): Promise<string | null> {
    const response = await request<{ type: 'exportTargetPicked'; path: string | null }>({
      type: 'pickExportTarget',
      filename,
      currentPath: currentPath?.trim() ? currentPath.trim() : null,
    });
    return response.path;
  }

  window.addEventListener('message', handleMessage);

  function dispose() {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('message', handleMessage);
    for (const pendingRequest of pending.values()) {
      pendingRequest.reject(new Error('VS Code export bridge disposed'));
    }
    pending.clear();
  }

  return {
    saveBlob,
    resolveExportTarget,
    pickExportTarget,
    contentContainer,
    dispose,
  };
}

function currentDocumentBuffer(
  path: string,
  getCurrentMarkdown: () => string | null,
  getCurrentFileName: () => string | null,
): ArrayBuffer | null {
  const fileName = getCurrentFileName();
  const markdown = getCurrentMarkdown();
  if (!fileName || markdown === null) return null;
  if (pathWithoutSuffix(path) !== fileName) return null;
  return new TextEncoder().encode(markdown).buffer as ArrayBuffer;
}

function pathWithoutSuffix(path: string): string {
  return path.split(/[?#]/, 1)[0]?.replace(/\\/g, '/').replace(/^\/+/, '') ?? '';
}

async function blobToBase64(blob: Blob): Promise<string> {
  return arrayBufferToBase64(await blob.arrayBuffer());
}

function arrayBufferToBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer as ArrayBuffer;
}
