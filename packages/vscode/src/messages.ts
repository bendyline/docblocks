/**
 * Typed message protocol between the extension host and webview.
 */

/** Messages sent from the extension host to the webview. */
export type ExtensionToWebviewMessage =
  | { type: 'setContent'; content: string; version: number; fileName: string }
  | { type: 'themeChange'; theme: 'light' | 'dark' }
  | { type: 'mediaResolved'; requestId: number; url: string }
  | { type: 'mediaListed'; requestId: number; entries: MediaEntryMessage[] }
  | { type: 'mediaAdded'; requestId: number; path: string }
  | { type: 'mediaRemoved'; requestId: number }
  | { type: 'mediaError'; requestId: number; message: string }
  | { type: 'exportSaved'; requestId: number; uri: string | null; path: string | null }
  | { type: 'exportError'; requestId: number; message: string }
  | { type: 'exportTargetResolved'; requestId: number; path: string }
  | { type: 'exportTargetPicked'; requestId: number; path: string | null }
  | { type: 'workspaceFileRead'; requestId: number; dataBase64: string | null }
  | { type: 'workspaceFileError'; requestId: number; message: string };

/** Messages sent from the webview to the extension host. */
export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'edit'; content: string }
  | { type: 'save'; content: string }
  | { type: 'resolveMedia'; requestId: number; ref: string }
  | { type: 'listMedia'; requestId: number }
  | { type: 'addMedia'; requestId: number; name: string; dataBase64: string; mimeType: string }
  | { type: 'removeMedia'; requestId: number; ref: string }
  | {
      type: 'saveExport';
      requestId: number;
      filename: string;
      dataBase64: string;
      mimeType: string;
      targetPath: string | null;
    }
  | { type: 'resolveExportTarget'; requestId: number; filename: string }
  | { type: 'pickExportTarget'; requestId: number; filename: string; currentPath: string | null }
  | { type: 'readWorkspaceFile'; requestId: number; path: string };

export interface MediaEntryMessage {
  name: string;
  mimeType: string;
  size: number;
}
