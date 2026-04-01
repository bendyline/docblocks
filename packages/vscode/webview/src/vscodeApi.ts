/**
 * Typed wrapper around VS Code's webview API.
 */

import type { WebviewToExtensionMessage } from '../../src/messages.js';

interface VsCodeApi {
  postMessage(message: WebviewToExtensionMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

// VS Code injects this global function into webviews.
// It can only be called once, so we cache the result.
let api: VsCodeApi | undefined;

export function getVscodeApi(): VsCodeApi {
  if (!api) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api = (window as any).acquireVsCodeApi();
  }
  return api!;
}
