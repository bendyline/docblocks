import { HOST_WIRE_LIMITS, isBoundedString } from '@bendyline/docblocks/host';
import {
  isSafeExportFilename,
  isSafeMimeType,
  parseExtensionToWebviewMessage,
  type ExportTargetGrantMessage,
  type ExtensionToWebviewMessage,
  type WebviewToExtensionMessage,
} from '@bendyline/docblocks/vscode';
import type { ContentContainer, ContentEntry } from '@bendyline/squisq/storage';
import { decodeBoundedBase64, encodeBoundedBase64 } from '../../src/wirePayload.js';
import { WebviewRequestRegistry } from './webviewRequestRegistry.js';

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

export interface VscodeExportBridgeOptions {
  requestTimeoutMs?: number;
}

export function createVscodeExportBridge(
  postMessage: (message: WebviewToExtensionMessage) => void,
  getCurrentMarkdown: () => string | null,
  getCurrentFileName: () => string | null,
  options: VscodeExportBridgeOptions = {},
): VscodeExportBridge {
  const requests = new WebviewRequestRegistry<ExportBridgeResponse>({
    label: 'VS Code export',
    maxPending: MAX_PENDING_REQUESTS,
    timeoutMs: options.requestTimeoutMs,
  });

  function request<TType extends ExportBridgeResponse['type']>(
    message: ExportBridgeRequest,
    expectedType: TType,
  ): Promise<Extract<ExportBridgeResponse, { type: TType }>> {
    return requests.request(expectedType, (requestId) => {
      postMessage({ ...message, requestId } as WebviewToExtensionMessage);
    });
  }

  function handleMessage(event: MessageEvent<unknown>) {
    const msg: ExtensionToWebviewMessage | null = parseExtensionToWebviewMessage(event.data);
    if (!msg) return;
    switch (msg.type) {
      case 'exportSaved':
        requests.settle(msg.requestId, { type: 'exportSaved', target: msg.target });
        break;
      case 'exportError':
        requests.reject(msg.requestId, new Error(msg.message));
        break;
      case 'exportTargetResolved':
        requests.settle(msg.requestId, { type: 'exportTargetResolved', target: msg.target });
        break;
      case 'exportTargetPicked':
        requests.settle(msg.requestId, { type: 'exportTargetPicked', target: msg.target });
        break;
      case 'workspaceFileRead':
        requests.settle(msg.requestId, {
          type: 'workspaceFileRead',
          dataBase64: msg.dataBase64,
        });
        break;
      case 'workspaceFileError':
        requests.reject(msg.requestId, new Error(msg.message));
        break;
    }
  }

  async function readFile(path: string): Promise<ArrayBuffer | null> {
    if (!isBoundedString(path, HOST_WIRE_LIMITS.pathCharacters, 1)) return null;
    const current = currentDocumentBuffer(path, getCurrentMarkdown, getCurrentFileName);
    if (current) return current;

    const response = await request({ type: 'readWorkspaceFile', path }, 'workspaceFileRead');
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
    const response = await request(
      {
        type: 'saveExport',
        filename,
        dataBase64: encodeBoundedBase64(new Uint8Array(await blob.arrayBuffer())),
        mimeType,
        grantId: target?.grantId ?? null,
      },
      'exportSaved',
    );
    return response.target;
  }

  async function resolveExportTarget(filename: string): Promise<ExportTargetGrantMessage | null> {
    if (!isSafeExportFilename(filename)) throw new Error('The export filename is invalid');
    const response = await request(
      { type: 'resolveExportTarget', filename },
      'exportTargetResolved',
    );
    return response.target;
  }

  async function pickExportTarget(
    filename: string,
    currentTarget?: ExportTargetGrantMessage | null,
  ): Promise<ExportTargetGrantMessage | null> {
    if (!isSafeExportFilename(filename)) throw new Error('The export filename is invalid');
    const response = await request(
      {
        type: 'pickExportTarget',
        filename,
        currentGrantId: currentTarget?.grantId ?? null,
      },
      'exportTargetPicked',
    );
    return response.target;
  }

  window.addEventListener('message', handleMessage);

  function dispose() {
    window.removeEventListener('message', handleMessage);
    requests.dispose();
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
