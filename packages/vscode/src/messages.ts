/**
 * Typed message protocol between the extension host and webview.
 */

import { HOST_WIRE_LIMITS, isBoundedString } from '@bendyline/docblocks/host';

const MAX_REQUEST_ID = 2_147_483_647;

export type DocumentSessionMessageStatus =
  | 'idle'
  | 'saved'
  | 'dirty'
  | 'saving'
  | 'error'
  | 'conflict'
  | 'closed';

export type DocumentConflictChoice = 'use-local' | 'use-external';

/**
 * An opaque, one-shot authority to write one host-owned export target.
 * The label is presentation-only and must never be interpreted as a path.
 */
export interface ExportTargetGrantMessage {
  grantId: string;
  displayLabel: string;
}

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
  | { type: 'exportSaved'; requestId: number; target: ExportTargetGrantMessage | null }
  | { type: 'exportError'; requestId: number; message: string }
  | { type: 'exportTargetResolved'; requestId: number; target: ExportTargetGrantMessage | null }
  | { type: 'exportTargetPicked'; requestId: number; target: ExportTargetGrantMessage | null }
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
      grantId: string | null;
    }
  | { type: 'resolveExportTarget'; requestId: number; filename: string }
  | {
      type: 'pickExportTarget';
      requestId: number;
      filename: string;
      currentGrantId: string | null;
    }
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
      return hasOnlyKeys(value, ['type']) ? { type: 'ready' } : null;
    case 'edit':
      return hasOnlyKeys(value, [
        'type',
        'content',
        'sessionId',
        'clientRevision',
        'baseDocumentVersion',
      ]) &&
        hasBoundedString(value, 'content', HOST_WIRE_LIMITS.documentCharacters) &&
        isSessionEnvelope(value)
        ? {
            type: 'edit',
            content: value.content,
            sessionId: value.sessionId,
            clientRevision: value.clientRevision,
            baseDocumentVersion: value.baseDocumentVersion,
          }
        : null;
    case 'save':
      return hasOnlyKeys(value, [
        'type',
        'sessionId',
        'requestId',
        'clientRevision',
        'baseDocumentVersion',
      ]) &&
        isSessionEnvelope(value) &&
        hasRequestId(value)
        ? {
            type: 'save',
            sessionId: value.sessionId,
            requestId: value.requestId,
            clientRevision: value.clientRevision,
            baseDocumentVersion: value.baseDocumentVersion,
          }
        : null;
    case 'resolveConflict':
      return hasOnlyKeys(value, ['type', 'sessionId', 'choice']) &&
        hasBoundedString(value, 'sessionId', HOST_WIRE_LIMITS.identifierCharacters, 1) &&
        (value.choice === 'use-local' || value.choice === 'use-external')
        ? { type: 'resolveConflict', sessionId: value.sessionId, choice: value.choice }
        : null;
    case 'resolveMedia':
      return hasOnlyKeys(value, ['type', 'requestId', 'ref']) &&
        hasRequestId(value) &&
        hasBoundedString(value, 'ref', HOST_WIRE_LIMITS.pathCharacters, 1)
        ? { type: 'resolveMedia', requestId: value.requestId, ref: value.ref }
        : null;
    case 'listMedia':
      return hasOnlyKeys(value, ['type', 'requestId']) && hasRequestId(value)
        ? { type: 'listMedia', requestId: value.requestId }
        : null;
    case 'addMedia':
      return hasOnlyKeys(value, ['type', 'requestId', 'name', 'dataBase64', 'mimeType']) &&
        hasRequestId(value) &&
        hasBoundedString(value, 'name', HOST_WIRE_LIMITS.pathCharacters, 1) &&
        hasBoundedString(value, 'dataBase64', HOST_WIRE_LIMITS.base64Characters) &&
        hasMimeType(value, 'mimeType')
        ? {
            type: 'addMedia',
            requestId: value.requestId,
            name: value.name,
            dataBase64: value.dataBase64,
            mimeType: value.mimeType,
          }
        : null;
    case 'removeMedia':
      return hasOnlyKeys(value, ['type', 'requestId', 'ref']) &&
        hasRequestId(value) &&
        hasBoundedString(value, 'ref', HOST_WIRE_LIMITS.pathCharacters, 1)
        ? { type: 'removeMedia', requestId: value.requestId, ref: value.ref }
        : null;
    case 'saveExport':
      return hasOnlyKeys(value, [
        'type',
        'requestId',
        'filename',
        'dataBase64',
        'mimeType',
        'grantId',
      ]) &&
        hasRequestId(value) &&
        hasSafeFilename(value, 'filename') &&
        hasBoundedString(value, 'dataBase64', HOST_WIRE_LIMITS.base64Characters) &&
        hasMimeType(value, 'mimeType') &&
        hasNullableBoundedString(value, 'grantId', HOST_WIRE_LIMITS.identifierCharacters, 1)
        ? {
            type: 'saveExport',
            requestId: value.requestId,
            filename: value.filename,
            dataBase64: value.dataBase64,
            mimeType: value.mimeType,
            grantId: value.grantId,
          }
        : null;
    case 'resolveExportTarget':
      return hasOnlyKeys(value, ['type', 'requestId', 'filename']) &&
        hasRequestId(value) &&
        hasSafeFilename(value, 'filename')
        ? { type: 'resolveExportTarget', requestId: value.requestId, filename: value.filename }
        : null;
    case 'pickExportTarget':
      return hasOnlyKeys(value, ['type', 'requestId', 'filename', 'currentGrantId']) &&
        hasRequestId(value) &&
        hasSafeFilename(value, 'filename') &&
        hasNullableBoundedString(value, 'currentGrantId', HOST_WIRE_LIMITS.identifierCharacters, 1)
        ? {
            type: 'pickExportTarget',
            requestId: value.requestId,
            filename: value.filename,
            currentGrantId: value.currentGrantId,
          }
        : null;
    case 'readWorkspaceFile':
      return hasOnlyKeys(value, ['type', 'requestId', 'path']) &&
        hasRequestId(value) &&
        hasBoundedString(value, 'path', HOST_WIRE_LIMITS.pathCharacters, 1)
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
    hasBoundedString(value, 'sessionId', HOST_WIRE_LIMITS.identifierCharacters, 1) &&
    hasNonNegativeInteger(value, 'clientRevision') &&
    hasNonNegativeInteger(value, 'baseDocumentVersion')
  );
}

function hasRequestId(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { requestId: number } {
  return hasNonNegativeInteger(value, 'requestId') && value.requestId <= MAX_REQUEST_ID;
}

function hasBoundedString<K extends string>(
  value: Record<string, unknown>,
  key: K,
  maximumCharacters: number,
  minimumCharacters = 0,
): value is Record<string, unknown> & Record<K, string> {
  return isBoundedString(value[key], maximumCharacters, minimumCharacters);
}

function hasNullableBoundedString<K extends string>(
  value: Record<string, unknown>,
  key: K,
  maximumCharacters: number,
  minimumCharacters = 0,
): value is Record<string, unknown> & Record<K, string | null> {
  return value[key] === null || isBoundedString(value[key], maximumCharacters, minimumCharacters);
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

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function hasSafeFilename<K extends string>(
  value: Record<string, unknown>,
  key: K,
): value is Record<string, unknown> & Record<K, string> {
  return isSafeExportFilename(value[key]);
}

export function isSafeExportFilename(value: unknown): value is string {
  return (
    isBoundedString(value, 255, 1) &&
    value.trim() === value &&
    !/[\\/:*?"<>|]/.test(value) &&
    !hasControlCharacter(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.endsWith('.') &&
    !value.endsWith(' ')
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function hasMimeType<K extends string>(
  value: Record<string, unknown>,
  key: K,
): value is Record<string, unknown> & Record<K, string> {
  return isSafeMimeType(value[key]);
}

export function isSafeMimeType(value: unknown): value is string {
  return (
    isBoundedString(value, HOST_WIRE_LIMITS.identifierCharacters, 1) &&
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=[^;\r\n]+)*$/.test(
      value,
    )
  );
}
