/**
 * Host-backed proofing persistence for the VS Code webview.
 *
 * A webview has no durable storage of its own — `localStorage` belongs to an
 * origin VS Code may not keep — so the two things Squisq refuses to write into
 * the document travel to the extension host instead: the app-wide dictionary
 * (global state) and this document's dismissed findings (workspace state).
 *
 * Neither request names a document. The panel owns exactly one, so the host
 * derives the key from its own URI rather than trusting anything from here.
 */

import {
  parseExtensionToWebviewMessage,
  type ExtensionToWebviewMessage,
  type WebviewToExtensionMessage,
} from '@bendyline/docblocks/vscode';
import type { ProofingIgnoreStore, ProofingProvider } from '@bendyline/squisq-editor-react';
import { WebviewRequestRegistry } from './webviewRequestRegistry.js';
import { createVscodeProofingProvider } from './proofingConfig.js';

const MAX_PENDING_REQUESTS = 16;

/**
 * Both round-trips read a small preference out of extension-host state, so
 * they either answer in milliseconds or something is wrong. The registry's
 * 60 s default is sized for file work; waiting that long here would leave a
 * document unproofed for a minute before falling back.
 */
const PROOFING_REQUEST_TIMEOUT_MS = 10_000;

type ProofingResponse =
  | { type: 'proofDictionaryLoaded'; words: string[] }
  | { type: 'proofIgnoresLoaded'; ignoredJson: string | null };

export interface VscodeProofingBridge {
  /**
   * The provider, once the host has returned the app dictionary — the words
   * must be in hand before construction, because seeding them afterwards would
   * force the engine to load before anyone asked for proofing.
   *
   * Resolves to `null` only when this build ships no engine.
   */
  readonly ready: Promise<ProofingProvider | null>;
  /** Per-document dismissals, persisted in the host's workspace state. */
  readonly ignoreStore: ProofingIgnoreStore;
  dispose(): void;
}

export interface VscodeProofingBridgeOptions {
  requestTimeoutMs?: number;
}

export function createVscodeProofingBridge(
  postMessage: (message: WebviewToExtensionMessage) => void,
  options: VscodeProofingBridgeOptions = {},
): VscodeProofingBridge {
  const requests = new WebviewRequestRegistry<ProofingResponse>({
    label: 'VS Code proofing',
    maxPending: MAX_PENDING_REQUESTS,
    timeoutMs: options.requestTimeoutMs ?? PROOFING_REQUEST_TIMEOUT_MS,
  });

  function handleMessage(event: MessageEvent<unknown>): void {
    const message: ExtensionToWebviewMessage | null = parseExtensionToWebviewMessage(event.data);
    if (!message) return;
    switch (message.type) {
      case 'proofDictionaryLoaded':
        requests.settle(message.requestId, {
          type: 'proofDictionaryLoaded',
          words: message.words,
        });
        break;
      case 'proofIgnoresLoaded':
        requests.settle(message.requestId, {
          type: 'proofIgnoresLoaded',
          ignoredJson: message.ignoredJson,
        });
        break;
      case 'proofStateError':
        requests.reject(message.requestId, new Error(message.message));
        break;
    }
  }
  window.addEventListener('message', handleMessage);

  const ignoreStore: ProofingIgnoreStore = {
    async load(): Promise<string | undefined> {
      try {
        const response = await requests.request('proofIgnoresLoaded', (requestId) => {
          postMessage({ type: 'loadProofIgnores', requestId });
        });
        return response.ignoredJson ?? undefined;
      } catch {
        // A dismissal that fails to come back is a lost convenience, not a
        // reason to leave the document unproofed.
        return undefined;
      }
    },
    save(_document, ignoredJson: string): void {
      postMessage({ type: 'saveProofIgnores', ignoredJson });
    },
  };

  const ready = (async (): Promise<ProofingProvider | null> => {
    let words: string[] = [];
    try {
      const response = await requests.request('proofDictionaryLoaded', (requestId) => {
        postMessage({ type: 'loadProofDictionary', requestId });
      });
      words = response.words;
    } catch {
      // Start with an empty dictionary rather than no proofing at all. New
      // words still persist; previously accepted ones reappear next session.
      words = [];
    }
    return createVscodeProofingProvider(words, (word) => {
      postMessage({ type: 'addProofDictionaryWord', word });
    });
  })();

  return {
    ready,
    ignoreStore,
    dispose(): void {
      window.removeEventListener('message', handleMessage);
      requests.dispose();
      void ready.then((provider) => provider?.dispose()).catch(() => undefined);
    },
  };
}
