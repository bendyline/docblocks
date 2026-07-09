import type { MediaEntry, MediaProvider } from '@bendyline/squisq/schemas';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../src/messages.js';

type MediaResponse =
  | { type: 'mediaResolved'; url: string }
  | { type: 'mediaListed'; entries: MediaEntry[] }
  | { type: 'mediaAdded'; path: string }
  | { type: 'mediaRemoved' };

type MediaBridgeRequest =
  | { type: 'resolveMedia'; ref: string }
  | { type: 'listMedia' }
  | { type: 'addMedia'; name: string; dataBase64: string; mimeType: string }
  | { type: 'removeMedia'; ref: string };

interface PendingRequest {
  resolve: (response: MediaResponse) => void;
  reject: (error: Error) => void;
}

export interface VscodeMediaBridge {
  mediaProvider: MediaProvider;
  dispose(): void;
}

export function createVscodeMediaBridge(
  postMessage: (message: WebviewToExtensionMessage) => void,
): VscodeMediaBridge {
  let nextRequestId = 1;
  let disposed = false;
  const pending = new Map<number, PendingRequest>();

  function request<T extends MediaResponse>(message: MediaBridgeRequest): Promise<T> {
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
      case 'mediaResolved':
        settle(msg.requestId, { type: 'mediaResolved', url: msg.url });
        break;
      case 'mediaListed':
        settle(msg.requestId, { type: 'mediaListed', entries: msg.entries });
        break;
      case 'mediaAdded':
        settle(msg.requestId, { type: 'mediaAdded', path: msg.path });
        break;
      case 'mediaRemoved':
        settle(msg.requestId, { type: 'mediaRemoved' });
        break;
      case 'mediaError':
        reject(msg.requestId, new Error(msg.message));
        break;
    }
  }

  function settle(requestId: number, response: MediaResponse) {
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

  window.addEventListener('message', handleMessage);

  function dispose() {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('message', handleMessage);
    for (const pendingRequest of pending.values()) {
      pendingRequest.reject(new Error('VS Code media bridge disposed'));
    }
    pending.clear();
  }

  return {
    mediaProvider: {
      async resolveUrl(ref: string): Promise<string> {
        if (isAlreadyDisplayableUrl(ref)) return ref;
        const response = await request<{ type: 'mediaResolved'; url: string }>({
          type: 'resolveMedia',
          ref,
        });
        return response.url;
      },

      async listMedia(): Promise<MediaEntry[]> {
        const response = await request<{ type: 'mediaListed'; entries: MediaEntry[] }>({
          type: 'listMedia',
        });
        return response.entries;
      },

      async addMedia(
        name: string,
        data: ArrayBuffer | Blob | Uint8Array,
        mimeType: string,
      ): Promise<string> {
        const response = await request<{ type: 'mediaAdded'; path: string }>({
          type: 'addMedia',
          name,
          dataBase64: await toBase64(data),
          mimeType,
        });
        return response.path;
      },

      async removeMedia(ref: string): Promise<void> {
        await request<{ type: 'mediaRemoved' }>({ type: 'removeMedia', ref });
      },

      dispose,
    },

    dispose,
  };
}

function isAlreadyDisplayableUrl(ref: string): boolean {
  return /^(?:blob:|data:|https?:)/i.test(ref);
}

async function toBase64(data: ArrayBuffer | Blob | Uint8Array): Promise<string> {
  const buffer =
    data instanceof Blob
      ? await data.arrayBuffer()
      : data instanceof Uint8Array
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data;
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
