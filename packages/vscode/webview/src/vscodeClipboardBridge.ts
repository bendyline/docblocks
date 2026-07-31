import { HOST_WIRE_LIMITS, isBoundedString } from '@bendyline/docblocks/host';
import {
  parseExtensionToWebviewMessage,
  type ExtensionToWebviewMessage,
  type WebviewToExtensionMessage,
} from '@bendyline/docblocks/vscode';
import { WebviewRequestRegistry } from './webviewRequestRegistry.js';

const MAX_PENDING_REQUESTS = 16;

type ClipboardResponse = { type: 'codeCopied' };

export interface VscodeClipboardBridge {
  copyCode(code: string): Promise<void>;
  dispose(): void;
}

export interface VscodeClipboardBridgeOptions {
  requestTimeoutMs?: number;
}

export function createVscodeClipboardBridge(
  postMessage: (message: WebviewToExtensionMessage) => void,
  options: VscodeClipboardBridgeOptions = {},
): VscodeClipboardBridge {
  const requests = new WebviewRequestRegistry<ClipboardResponse>({
    label: 'VS Code clipboard',
    maxPending: MAX_PENDING_REQUESTS,
    timeoutMs: options.requestTimeoutMs,
  });

  function handleMessage(event: MessageEvent<unknown>): void {
    const message: ExtensionToWebviewMessage | null = parseExtensionToWebviewMessage(event.data);
    if (!message) return;
    if (message.type === 'codeCopied') {
      requests.settle(message.requestId, { type: 'codeCopied' });
    } else if (message.type === 'codeCopyError') {
      requests.reject(message.requestId, new Error(message.message));
    }
  }

  window.addEventListener('message', handleMessage);

  return {
    async copyCode(code: string): Promise<void> {
      if (!isBoundedString(code, HOST_WIRE_LIMITS.documentCharacters)) {
        throw new Error('The code block exceeds the clipboard size limit');
      }
      await requests.request('codeCopied', (requestId) => {
        postMessage({ type: 'copyCode', requestId, code });
      });
    },

    dispose(): void {
      window.removeEventListener('message', handleMessage);
      requests.dispose();
    },
  };
}
