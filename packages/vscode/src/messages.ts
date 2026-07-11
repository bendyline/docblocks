/**
 * Typed message protocol between the extension host and webview.
 */

export type DocumentSessionMessageStatus =
  | 'idle'
  | 'saved'
  | 'dirty'
  | 'saving'
  | 'error'
  | 'conflict'
  | 'closed';

export type DocumentConflictChoice = 'use-local' | 'use-external';

/** Messages sent from the extension host to the webview. */
export type ExtensionToWebviewMessage =
  | {
      type: 'setContent';
      content: string;
      documentVersion: number;
      fileName: string;
      sessionId: string;
      sessionRevision: number;
      acknowledgedClientRevision: number;
    }
  | {
      type: 'editAcknowledged';
      sessionId: string;
      clientRevision: number;
      sessionRevision: number;
      accepted: boolean;
      message: string | null;
    }
  | {
      type: 'sessionState';
      sessionId: string;
      status: DocumentSessionMessageStatus;
      revision: number;
      persistedRevision: number;
      acknowledgedClientRevision: number;
      documentVersion: number;
      error: string | null;
    }
  | {
      type: 'saveResult';
      sessionId: string;
      requestId: number;
      ok: boolean;
      revision: number;
      persistedRevision: number;
      documentVersion: number;
      message: string | null;
    }
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
  | {
      type: 'edit';
      content: string;
      sessionId: string;
      clientRevision: number;
      baseDocumentVersion: number;
    }
  | {
      type: 'save';
      sessionId: string;
      requestId: number;
      clientRevision: number;
      baseDocumentVersion: number;
    }
  | { type: 'resolveConflict'; sessionId: string; choice: DocumentConflictChoice }
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

/**
 * The webview boundary is untrusted at runtime. Keep malformed or stale
 * messages out of the document session instead of relying on a TypeScript
 * assertion in the extension host.
 */
export function parseWebviewToExtensionMessage(value: unknown): WebviewToExtensionMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;

  switch (value.type) {
    case 'ready':
      return { type: 'ready' };
    case 'edit':
      return hasString(value, 'content') && isSessionEnvelope(value)
        ? {
            type: 'edit',
            content: value.content,
            sessionId: value.sessionId,
            clientRevision: value.clientRevision,
            baseDocumentVersion: value.baseDocumentVersion,
          }
        : null;
    case 'save':
      return isSessionEnvelope(value) && hasNonNegativeInteger(value, 'requestId')
        ? {
            type: 'save',
            sessionId: value.sessionId,
            requestId: value.requestId,
            clientRevision: value.clientRevision,
            baseDocumentVersion: value.baseDocumentVersion,
          }
        : null;
    case 'resolveConflict':
      return hasString(value, 'sessionId') &&
        (value.choice === 'use-local' || value.choice === 'use-external')
        ? { type: 'resolveConflict', sessionId: value.sessionId, choice: value.choice }
        : null;
    case 'resolveMedia':
      return hasRequestId(value) && hasString(value, 'ref')
        ? { type: 'resolveMedia', requestId: value.requestId, ref: value.ref }
        : null;
    case 'listMedia':
      return hasRequestId(value) ? { type: 'listMedia', requestId: value.requestId } : null;
    case 'addMedia':
      return hasRequestId(value) &&
        hasString(value, 'name') &&
        hasString(value, 'dataBase64') &&
        hasString(value, 'mimeType')
        ? {
            type: 'addMedia',
            requestId: value.requestId,
            name: value.name,
            dataBase64: value.dataBase64,
            mimeType: value.mimeType,
          }
        : null;
    case 'removeMedia':
      return hasRequestId(value) && hasString(value, 'ref')
        ? { type: 'removeMedia', requestId: value.requestId, ref: value.ref }
        : null;
    case 'saveExport':
      return hasRequestId(value) &&
        hasString(value, 'filename') &&
        hasString(value, 'dataBase64') &&
        hasString(value, 'mimeType') &&
        hasNullableString(value, 'targetPath')
        ? {
            type: 'saveExport',
            requestId: value.requestId,
            filename: value.filename,
            dataBase64: value.dataBase64,
            mimeType: value.mimeType,
            targetPath: value.targetPath,
          }
        : null;
    case 'resolveExportTarget':
      return hasRequestId(value) && hasString(value, 'filename')
        ? { type: 'resolveExportTarget', requestId: value.requestId, filename: value.filename }
        : null;
    case 'pickExportTarget':
      return hasRequestId(value) &&
        hasString(value, 'filename') &&
        hasNullableString(value, 'currentPath')
        ? {
            type: 'pickExportTarget',
            requestId: value.requestId,
            filename: value.filename,
            currentPath: value.currentPath,
          }
        : null;
    case 'readWorkspaceFile':
      return hasRequestId(value) && hasString(value, 'path')
        ? { type: 'readWorkspaceFile', requestId: value.requestId, path: value.path }
        : null;
    default:
      return null;
  }
}

function isSessionEnvelope(value: Record<string, unknown>): value is Record<string, unknown> & {
  sessionId: string;
  clientRevision: number;
  baseDocumentVersion: number;
} {
  return (
    hasString(value, 'sessionId') &&
    value.sessionId.length > 0 &&
    hasNonNegativeInteger(value, 'clientRevision') &&
    hasNonNegativeInteger(value, 'baseDocumentVersion')
  );
}

function hasRequestId(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { requestId: number } {
  return hasNonNegativeInteger(value, 'requestId');
}

function hasString<K extends string>(
  value: Record<string, unknown>,
  key: K,
): value is Record<string, unknown> & Record<K, string> {
  return typeof value[key] === 'string';
}

function hasNullableString<K extends string>(
  value: Record<string, unknown>,
  key: K,
): value is Record<string, unknown> & Record<K, string | null> {
  return value[key] === null || typeof value[key] === 'string';
}

function hasNonNegativeInteger<K extends string>(
  value: Record<string, unknown>,
  key: K,
): value is Record<string, unknown> & Record<K, number> {
  const entry = value[key];
  return typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
