/**
 * Typed wrapper around VS Code's webview API.
 */

import type { WebviewToExtensionMessage } from '@bendyline/docblocks/vscode';

interface VsCodeApi {
  postMessage(message: WebviewToExtensionMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

interface VsCodeWebviewWindow extends Window {
  acquireVsCodeApi?: () => VsCodeApi;
}

// VS Code injects this global function into webviews.
// It can only be called once, so we cache the result.
let api: VsCodeApi | undefined;

export function getVscodeApi(): VsCodeApi {
  if (!api) {
    const acquireVsCodeApi = (window as VsCodeWebviewWindow).acquireVsCodeApi;
    if (typeof acquireVsCodeApi !== 'function') {
      throw new Error('The VS Code webview API is unavailable.');
    }
    api = acquireVsCodeApi();
  }
  return api;
}
