import { HOST_WIRE_LIMITS, isBoundedString, parseExternalHttpUrl } from '@bendyline/docblocks/host';
import {
  isSafeMimeType,
  parseExtensionToWebviewMessage,
  type ExtensionToWebviewMessage,
  type WebviewToExtensionMessage,
} from '@bendyline/docblocks/vscode';
import type { MediaEntry, MediaProvider } from '@bendyline/squisq/schemas';
import { encodeBoundedBase64 } from '../../src/wirePayload.js';
import { WebviewRequestRegistry } from './webviewRequestRegistry.js';

const MAX_PENDING_REQUESTS = 64;

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

export interface VscodeMediaBridge {
  mediaProvider: MediaProvider;
  dispose(): void;
}

export interface VscodeMediaBridgeOptions {
  requestTimeoutMs?: number;
}

export function createVscodeMediaBridge(
  postMessage: (message: WebviewToExtensionMessage) => void,
  options: VscodeMediaBridgeOptions = {},
): VscodeMediaBridge {
  const requests = new WebviewRequestRegistry<MediaResponse>({
    label: 'VS Code media',
    maxPending: MAX_PENDING_REQUESTS,
    timeoutMs: options.requestTimeoutMs,
  });

  function request<TType extends MediaResponse['type']>(
    message: MediaBridgeRequest,
    expectedType: TType,
  ): Promise<Extract<MediaResponse, { type: TType }>> {
    return requests.request(expectedType, (requestId) => {
      postMessage({ ...message, requestId } as WebviewToExtensionMessage);
    });
  }

  function handleMessage(event: MessageEvent<unknown>) {
    const msg: ExtensionToWebviewMessage | null = parseExtensionToWebviewMessage(event.data);
    if (!msg) return;
    switch (msg.type) {
      case 'mediaResolved':
        requests.settle(msg.requestId, { type: 'mediaResolved', url: msg.url });
        break;
      case 'mediaListed':
        requests.settle(msg.requestId, { type: 'mediaListed', entries: msg.entries });
        break;
      case 'mediaAdded':
        requests.settle(msg.requestId, { type: 'mediaAdded', path: msg.path });
        break;
      case 'mediaRemoved':
        requests.settle(msg.requestId, { type: 'mediaRemoved' });
        break;
      case 'mediaError':
        requests.reject(msg.requestId, new Error(msg.message));
        break;
    }
  }

  window.addEventListener('message', handleMessage);

  function dispose() {
    window.removeEventListener('message', handleMessage);
    requests.dispose();
  }

  return {
    mediaProvider: {
      async resolveUrl(ref: string): Promise<string> {
        const displayableUrl = parseDisplayableUrl(ref);
        if (displayableUrl) return displayableUrl;
        if (parseExternalHttpUrl(ref)) {
          throw new Error(
            'Remote media is blocked in the VS Code editor to protect your privacy. ' +
              "Download the file into this document's media folder to display it.",
          );
        }
        const response = await request({ type: 'resolveMedia', ref }, 'mediaResolved');
        return response.url;
      },

      async listMedia(): Promise<MediaEntry[]> {
        const response = await request({ type: 'listMedia' }, 'mediaListed');
        return response.entries;
      },

      async addMedia(
        name: string,
        data: ArrayBuffer | Blob | Uint8Array,
        mimeType: string,
      ): Promise<string> {
        if (!isBoundedString(name, HOST_WIRE_LIMITS.pathCharacters, 1)) {
          throw new Error('The media name is invalid');
        }
        if (!isSafeMimeType(mimeType)) {
          throw new Error('The media type is invalid');
        }
        const response = await request(
          {
            type: 'addMedia',
            name,
            dataBase64: await toBase64(data),
            mimeType,
          },
          'mediaAdded',
        );
        return response.path;
      },

      async removeMedia(ref: string): Promise<void> {
        await request({ type: 'removeMedia', ref }, 'mediaRemoved');
      },

      dispose,
    },

    dispose,
  };
}

function parseDisplayableUrl(ref: string): string | null {
  if (!isBoundedString(ref, HOST_WIRE_LIMITS.urlCharacters, 1)) return null;
  if (ref.startsWith('blob:') || ref.startsWith('data:')) return ref;
  return null;
}

async function toBase64(data: ArrayBuffer | Blob | Uint8Array): Promise<string> {
  const buffer =
    data instanceof Blob
      ? await data.arrayBuffer()
      : data instanceof Uint8Array
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data;
  const bytes = new Uint8Array(buffer);
  return encodeBoundedBase64(bytes);
}
