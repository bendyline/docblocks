import { HOST_WIRE_LIMITS, isBoundedString } from '@bendyline/docblocks/host';
import type { ContentContainer, ContentEntry } from '@bendyline/squisq/storage';
import type {
  ExportTargetGrantMessage,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../src/messages.js';
import { isSafeExportFilename, isSafeMimeType } from '../../src/messages.js';
import { decodeBoundedBase64, encodeBoundedBase64 } from '../../src/wirePayload.js';

const MAX_PENDING_REQUESTS = 64;

type ExportBridgeResponse =
  | { type: 'exportSaved'; target: ExportTargetGrantMessage | null }
  | { type: 'exportTargetResolved'; target: ExportTargetGrantMessage | null }
  | { type: 'exportTargetPicked'; target: ExportTargetGrantMessage | null }
  | { type: 'workspaceFileRead'; dataBase64: string | null };

type ExportBridgeRequest =
  | {
      type: 'saveExport';
      filename: string;
      dataBase64: string;
      mimeType: string;
      grantId: string | null;
    }
  | { type: 'resolveExportTarget'; filename: string }
  | { type: 'pickExportTarget'; filename: string; currentGrantId: string | null }
  | { type: 'readWorkspaceFile'; path: string };

interface PendingRequest {
  resolve: (response: ExportBridgeResponse) => void;
  reject: (error: Error) => void;
}

export interface VscodeExportBridge {
  saveBlob(
    blob: Blob,
    filename: string,
    target?: ExportTargetGrantMessage | null,
  ): Promise<ExportTargetGrantMessage | null>;
  resolveExportTarget(filename: string): Promise<ExportTargetGrantMessage | null>;
  pickExportTarget(
    filename: string,
    currentTarget?: ExportTargetGrantMessage | null,
  ): Promise<ExportTargetGrantMessage | null>;
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
    if (disposed) return Promise.reject(new Error('VS Code export bridge disposed'));
    if (pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error('Too many pending VS Code export requests'));
    }

    const requestId = nextRequestId;
    nextRequestId = nextRequestId >= 2_147_483_647 ? 1 : nextRequestId + 1;

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
        settle(msg.requestId, { type: 'exportSaved', target: msg.target });
        break;
      case 'exportError':
        reject(msg.requestId, new Error(msg.message));
        break;
      case 'exportTargetResolved':
        settle(msg.requestId, { type: 'exportTargetResolved', target: msg.target });
        break;
      case 'exportTargetPicked':
        settle(msg.requestId, { type: 'exportTargetPicked', target: msg.target });
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
    if (!isBoundedString(path, HOST_WIRE_LIMITS.pathCharacters, 1)) return null;
    const current = currentDocumentBuffer(path, getCurrentMarkdown, getCurrentFileName);
    if (current) return current;

    const response = await request<{ type: 'workspaceFileRead'; dataBase64: string | null }>({
      type: 'readWorkspaceFile',
      path,
    });
    if (!response.dataBase64) return null;
    const bytes = decodeBoundedBase64(response.dataBase64);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
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
    target?: ExportTargetGrantMessage | null,
  ): Promise<ExportTargetGrantMessage | null> {
    if (!isSafeExportFilename(filename)) throw new Error('The export filename is invalid');
    if (blob.size > HOST_WIRE_LIMITS.binaryBytes) {
      throw new Error('The export exceeds the allowed size');
    }
    const mimeType = blob.type || 'application/octet-stream';
    if (!isSafeMimeType(mimeType)) throw new Error('The export media type is invalid');
    const response = await request<{
      type: 'exportSaved';
      target: ExportTargetGrantMessage | null;
    }>({
      type: 'saveExport',
      filename,
      dataBase64: encodeBoundedBase64(new Uint8Array(await blob.arrayBuffer())),
      mimeType,
      grantId: target?.grantId ?? null,
    });
    return response.target;
  }

  async function resolveExportTarget(filename: string): Promise<ExportTargetGrantMessage | null> {
    if (!isSafeExportFilename(filename)) throw new Error('The export filename is invalid');
    const response = await request<{
      type: 'exportTargetResolved';
      target: ExportTargetGrantMessage | null;
    }>({
      type: 'resolveExportTarget',
      filename,
    });
    return response.target;
  }

  async function pickExportTarget(
    filename: string,
    currentTarget?: ExportTargetGrantMessage | null,
  ): Promise<ExportTargetGrantMessage | null> {
    if (!isSafeExportFilename(filename)) throw new Error('The export filename is invalid');
    const response = await request<{
      type: 'exportTargetPicked';
      target: ExportTargetGrantMessage | null;
    }>({
      type: 'pickExportTarget',
      filename,
      currentGrantId: currentTarget?.grantId ?? null,
    });
    return response.target;
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
