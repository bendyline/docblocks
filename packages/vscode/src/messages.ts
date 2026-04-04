/**
 * Typed message protocol between the extension host and webview.
 */

/** Messages sent from the extension host to the webview. */
export type ExtensionToWebviewMessage =
  | { type: 'setContent'; content: string; version: number }
  | { type: 'themeChange'; theme: 'light' | 'dark' };

/** Messages sent from the webview to the extension host. */
export type WebviewToExtensionMessage = { type: 'ready' } | { type: 'edit'; content: string };
