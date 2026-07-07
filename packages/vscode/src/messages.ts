/**
 * Typed message protocol between the extension host and webview.
 */

/** Messages sent from the extension host to the webview. */
export type ExtensionToWebviewMessage =
  | { type: 'setContent'; content: string; version: number }
  | { type: 'themeChange'; theme: 'light' | 'dark' }
  | { type: 'mediaResolved'; requestId: number; url: string }
  | { type: 'mediaListed'; requestId: number; entries: MediaEntryMessage[] }
  | { type: 'mediaAdded'; requestId: number; path: string }
  | { type: 'mediaRemoved'; requestId: number }
  | { type: 'mediaError'; requestId: number; message: string };

/** Messages sent from the webview to the extension host. */
export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'edit'; content: string }
  | { type: 'resolveMedia'; requestId: number; ref: string }
  | { type: 'listMedia'; requestId: number }
  | { type: 'addMedia'; requestId: number; name: string; dataBase64: string; mimeType: string }
  | { type: 'removeMedia'; requestId: number; ref: string };

export interface MediaEntryMessage {
  name: string;
  mimeType: string;
  size: number;
}
