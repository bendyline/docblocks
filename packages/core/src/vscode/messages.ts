/**
 * Typed message protocol between the extension host and webview.
 */

import { HOST_WIRE_LIMITS, isBoundedString } from '../host/wire-policy.js';

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

/** Host-observed details that help a user distinguish two text branches. */
export interface DocumentConflictDetailsMessage {
  /** VS Code document version on which the DocBlocks draft was based. */
  localBaseDocumentVersion: number;
  /** Current VS Code document version observed outside the DocBlocks edit pipeline. */
  externalDocumentVersion: number;
  /** UTF-8 encoded sizes of the complete text snapshots. */
  localBytes: number;
  externalBytes: number | null;
  /** Times are extension-host observations, not filesystem-authoritative mtimes. */
  localEditedAt: number | null;
  externalObservedAt: number | null;
  /** Whether VS Code reported the external document snapshot as not yet saved. */
  externalIsDirty: boolean | null;
}

export const DOCBLOCKS_ACCENT_COLORS = [
  'brown',
  'green',
  'blue',
  'purple',
  'maroon',
  'orange',
  'gray',
] as const;

export type DocBlocksAccentColor = (typeof DOCBLOCKS_ACCENT_COLORS)[number];

export const DOCBLOCKS_WRITE_CANVAS_TEXT_SIZE_MIN = 12;
export const DOCBLOCKS_WRITE_CANVAS_TEXT_SIZE_MAX = 32;
export const DOCBLOCKS_WRITE_CANVAS_LINE_SPACING_MIN = 1;
export const DOCBLOCKS_WRITE_CANVAS_LINE_SPACING_MAX = 2.4;

/**
 * Stable ids for the Write-canvas font schemes. This is the wire/persisted
 * contract for the font choice; the human labels and the resolved CSS
 * font-family strings live with the UI in `@bendyline/docblocks-react`
 * (`WRITE_CANVAS_FONT_SCHEMES`). A guard test keeps this list, the react
 * registry, and the VS Code `package.json` enum in sync. `'theme'` is the
 * default and means "inherit from the active theme override".
 */
export const DOCBLOCKS_WRITE_CANVAS_FONT_SCHEMES = [
  'theme',
  'serif-sans',
  'sans-sans',
  'serif-serif',
  'pt-serif',
  'hanken',
  'playfair-pt-serif',
  'hanken-lora',
  'dm-serif-dm-sans',
  'inter',
] as const;

export type DocBlocksWriteCanvasFontScheme = (typeof DOCBLOCKS_WRITE_CANVAS_FONT_SCHEMES)[number];

export interface VscodeWriteCanvasSettings {
  textSize: number;
  lineSpacing: number;
  fontScheme: DocBlocksWriteCanvasFontScheme;
}

export const DEFAULT_VSCODE_WRITE_CANVAS_SETTINGS: Readonly<VscodeWriteCanvasSettings> = {
  textSize: 16,
  lineSpacing: 1.7,
  fontScheme: 'theme',
};

export interface VscodeEditorSettings {
  autoSave: boolean;
  accentColor: DocBlocksAccentColor;
  writeCanvasSettings: VscodeWriteCanvasSettings;
}

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
      conflict: DocumentConflictDetailsMessage | null;
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
  | { type: 'editorSettings'; settings: VscodeEditorSettings }
  | { type: 'codeCopied'; requestId: number }
  | { type: 'codeCopyError'; requestId: number; message: string }
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
  | { type: 'setAutoSave'; enabled: boolean }
  | { type: 'setAccentColor'; accentColor: DocBlocksAccentColor }
  | { type: 'setWriteCanvasSettings'; settings: VscodeWriteCanvasSettings }
  | { type: 'openLink'; href: string }
  | { type: 'copyCode'; requestId: number; code: string }
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
      /** Optional validated basename edit; the host derives it from the opaque grant. */
      targetFilename: string | null;
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
    case 'setAutoSave':
      return hasOnlyKeys(value, ['type', 'enabled']) && typeof value.enabled === 'boolean'
        ? { type: 'setAutoSave', enabled: value.enabled }
        : null;
    case 'setAccentColor':
      return hasOnlyKeys(value, ['type', 'accentColor']) &&
        isDocBlocksAccentColor(value.accentColor)
        ? { type: 'setAccentColor', accentColor: value.accentColor }
        : null;
    case 'setWriteCanvasSettings': {
      if (!hasOnlyKeys(value, ['type', 'settings'])) return null;
      const settings = parseVscodeWriteCanvasSettings(value.settings);
      return settings ? { type: 'setWriteCanvasSettings', settings } : null;
    }
    case 'openLink':
      return hasOnlyKeys(value, ['type', 'href']) &&
        hasBoundedString(value, 'href', HOST_WIRE_LIMITS.urlCharacters, 1)
        ? { type: 'openLink', href: value.href }
        : null;
    case 'copyCode':
      return hasOnlyKeys(value, ['type', 'requestId', 'code']) &&
        hasRequestId(value) &&
        hasBoundedString(value, 'code', HOST_WIRE_LIMITS.documentCharacters)
        ? { type: 'copyCode', requestId: value.requestId, code: value.code }
        : null;
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
        'targetFilename',
      ]) &&
        hasRequestId(value) &&
        hasSafeFilename(value, 'filename') &&
        hasBoundedString(value, 'dataBase64', HOST_WIRE_LIMITS.base64Characters) &&
        hasMimeType(value, 'mimeType') &&
        hasNullableBoundedString(value, 'grantId', HOST_WIRE_LIMITS.identifierCharacters, 1) &&
        hasNullableSafeFilename(value, 'targetFilename')
        ? {
            type: 'saveExport',
            requestId: value.requestId,
            filename: value.filename,
            dataBase64: value.dataBase64,
            mimeType: value.mimeType,
            grantId: value.grantId,
            targetFilename: value.targetFilename,
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

/**
 * Validate host responses before they influence webview state. This protects
 * the browser side from protocol drift and from messages injected by another
 * script in the webview document; a TypeScript MessageEvent annotation is not
 * runtime validation.
 */
export function parseExtensionToWebviewMessage(value: unknown): ExtensionToWebviewMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;

  switch (value.type) {
    case 'setContent':
      return hasOnlyKeys(value, [
        'type',
        'content',
        'documentVersion',
        'fileName',
        'sessionId',
        'sessionRevision',
        'acknowledgedClientRevision',
      ]) &&
        hasBoundedString(value, 'content', HOST_WIRE_LIMITS.documentCharacters) &&
        hasNonNegativeInteger(value, 'documentVersion') &&
        hasBoundedString(value, 'fileName', HOST_WIRE_LIMITS.pathCharacters, 1) &&
        hasBoundedString(value, 'sessionId', HOST_WIRE_LIMITS.identifierCharacters, 1) &&
        hasNonNegativeInteger(value, 'sessionRevision') &&
        hasNonNegativeInteger(value, 'acknowledgedClientRevision')
        ? {
            type: 'setContent',
            content: value.content,
            documentVersion: value.documentVersion,
            fileName: value.fileName,
            sessionId: value.sessionId,
            sessionRevision: value.sessionRevision,
            acknowledgedClientRevision: value.acknowledgedClientRevision,
          }
        : null;
    case 'editAcknowledged':
      return hasOnlyKeys(value, [
        'type',
        'sessionId',
        'clientRevision',
        'sessionRevision',
        'accepted',
        'message',
      ]) &&
        hasBoundedString(value, 'sessionId', HOST_WIRE_LIMITS.identifierCharacters, 1) &&
        hasNonNegativeInteger(value, 'clientRevision') &&
        hasNonNegativeInteger(value, 'sessionRevision') &&
        typeof value.accepted === 'boolean' &&
        hasNullableBoundedString(value, 'message', HOST_WIRE_LIMITS.messageCharacters)
        ? {
            type: 'editAcknowledged',
            sessionId: value.sessionId,
            clientRevision: value.clientRevision,
            sessionRevision: value.sessionRevision,
            accepted: value.accepted,
            message: value.message,
          }
        : null;
    case 'sessionState': {
      if (
        !hasOnlyKeys(value, [
          'type',
          'sessionId',
          'status',
          'revision',
          'persistedRevision',
          'acknowledgedClientRevision',
          'documentVersion',
          'error',
          'conflict',
        ]) ||
        !hasBoundedString(value, 'sessionId', HOST_WIRE_LIMITS.identifierCharacters, 1) ||
        !isDocumentSessionMessageStatus(value.status) ||
        !hasNonNegativeInteger(value, 'revision') ||
        !hasNonNegativeInteger(value, 'persistedRevision') ||
        value.persistedRevision > value.revision ||
        !hasNonNegativeInteger(value, 'acknowledgedClientRevision') ||
        !hasNonNegativeInteger(value, 'documentVersion') ||
        !hasNullableBoundedString(value, 'error', HOST_WIRE_LIMITS.messageCharacters)
      ) {
        return null;
      }
      const conflict = parseDocumentConflictDetails(value.conflict);
      if (
        conflict === undefined ||
        (value.status === 'conflict' && conflict === null) ||
        (value.status !== 'conflict' && conflict !== null)
      ) {
        return null;
      }
      return {
        type: 'sessionState',
        sessionId: value.sessionId,
        status: value.status,
        revision: value.revision,
        persistedRevision: value.persistedRevision,
        acknowledgedClientRevision: value.acknowledgedClientRevision,
        documentVersion: value.documentVersion,
        error: value.error,
        conflict,
      };
    }
    case 'saveResult':
      return hasOnlyKeys(value, [
        'type',
        'sessionId',
        'requestId',
        'ok',
        'revision',
        'persistedRevision',
        'documentVersion',
        'message',
      ]) &&
        hasBoundedString(value, 'sessionId', HOST_WIRE_LIMITS.identifierCharacters, 1) &&
        hasRequestId(value) &&
        typeof value.ok === 'boolean' &&
        hasNonNegativeInteger(value, 'revision') &&
        hasNonNegativeInteger(value, 'persistedRevision') &&
        value.persistedRevision <= value.revision &&
        hasNonNegativeInteger(value, 'documentVersion') &&
        hasNullableBoundedString(value, 'message', HOST_WIRE_LIMITS.messageCharacters)
        ? {
            type: 'saveResult',
            sessionId: value.sessionId,
            requestId: value.requestId,
            ok: value.ok,
            revision: value.revision,
            persistedRevision: value.persistedRevision,
            documentVersion: value.documentVersion,
            message: value.message,
          }
        : null;
    case 'themeChange':
      return hasOnlyKeys(value, ['type', 'theme']) &&
        (value.theme === 'light' || value.theme === 'dark')
        ? { type: 'themeChange', theme: value.theme }
        : null;
    case 'editorSettings': {
      if (!hasOnlyKeys(value, ['type', 'settings'])) return null;
      const settings = parseVscodeEditorSettings(value.settings);
      return settings ? { type: 'editorSettings', settings } : null;
    }
    case 'codeCopied':
      return hasOnlyKeys(value, ['type', 'requestId']) && hasRequestId(value)
        ? { type: 'codeCopied', requestId: value.requestId }
        : null;
    case 'codeCopyError':
      return hasOnlyKeys(value, ['type', 'requestId', 'message']) &&
        hasRequestId(value) &&
        hasBoundedString(value, 'message', HOST_WIRE_LIMITS.messageCharacters, 1)
        ? { type: 'codeCopyError', requestId: value.requestId, message: value.message }
        : null;
    case 'mediaResolved':
      return hasOnlyKeys(value, ['type', 'requestId', 'url']) &&
        hasRequestId(value) &&
        isBoundedMediaDataUrl(value.url)
        ? { type: 'mediaResolved', requestId: value.requestId, url: value.url }
        : null;
    case 'mediaListed': {
      if (!hasOnlyKeys(value, ['type', 'requestId', 'entries']) || !hasRequestId(value)) {
        return null;
      }
      const entries = parseMediaEntries(value.entries);
      return entries ? { type: 'mediaListed', requestId: value.requestId, entries } : null;
    }
    case 'mediaAdded':
      return hasOnlyKeys(value, ['type', 'requestId', 'path']) &&
        hasRequestId(value) &&
        hasBoundedString(value, 'path', HOST_WIRE_LIMITS.pathCharacters, 1)
        ? { type: 'mediaAdded', requestId: value.requestId, path: value.path }
        : null;
    case 'mediaRemoved':
      return hasOnlyKeys(value, ['type', 'requestId']) && hasRequestId(value)
        ? { type: 'mediaRemoved', requestId: value.requestId }
        : null;
    case 'mediaError':
    case 'exportError':
    case 'workspaceFileError':
      return hasOnlyKeys(value, ['type', 'requestId', 'message']) &&
        hasRequestId(value) &&
        hasBoundedString(value, 'message', HOST_WIRE_LIMITS.messageCharacters, 1)
        ? { type: value.type, requestId: value.requestId, message: value.message }
        : null;
    case 'exportSaved':
    case 'exportTargetResolved':
    case 'exportTargetPicked': {
      if (!hasOnlyKeys(value, ['type', 'requestId', 'target']) || !hasRequestId(value)) {
        return null;
      }
      const target = parseExportTargetGrant(value.target);
      return target !== undefined ? { type: value.type, requestId: value.requestId, target } : null;
    }
    case 'workspaceFileRead':
      return hasOnlyKeys(value, ['type', 'requestId', 'dataBase64']) &&
        hasRequestId(value) &&
        hasNullableBoundedString(value, 'dataBase64', HOST_WIRE_LIMITS.base64Characters)
        ? { type: 'workspaceFileRead', requestId: value.requestId, dataBase64: value.dataBase64 }
        : null;
    default:
      return null;
  }
}

function parseExportTargetGrant(value: unknown): ExportTargetGrantMessage | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['grantId', 'displayLabel']) ||
    !hasBoundedString(value, 'grantId', HOST_WIRE_LIMITS.identifierCharacters, 1) ||
    !hasBoundedString(value, 'displayLabel', HOST_WIRE_LIMITS.pathCharacters, 1)
  ) {
    return undefined;
  }
  return { grantId: value.grantId, displayLabel: value.displayLabel };
}

function parseDocumentConflictDetails(
  value: unknown,
): DocumentConflictDetailsMessage | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'localBaseDocumentVersion',
      'externalDocumentVersion',
      'localBytes',
      'externalBytes',
      'localEditedAt',
      'externalObservedAt',
      'externalIsDirty',
    ]) ||
    !hasNonNegativeInteger(value, 'localBaseDocumentVersion') ||
    !hasNonNegativeInteger(value, 'externalDocumentVersion') ||
    !hasNonNegativeInteger(value, 'localBytes') ||
    !isNullableNonNegativeInteger(value.externalBytes) ||
    !isNullableNonNegativeInteger(value.localEditedAt) ||
    !isNullableNonNegativeInteger(value.externalObservedAt) ||
    (value.externalIsDirty !== null && typeof value.externalIsDirty !== 'boolean')
  ) {
    return undefined;
  }
  return {
    localBaseDocumentVersion: value.localBaseDocumentVersion,
    externalDocumentVersion: value.externalDocumentVersion,
    localBytes: value.localBytes,
    externalBytes: value.externalBytes,
    localEditedAt: value.localEditedAt,
    externalObservedAt: value.externalObservedAt,
    externalIsDirty: value.externalIsDirty,
  };
}

function parseVscodeEditorSettings(value: unknown): VscodeEditorSettings | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['autoSave', 'accentColor', 'writeCanvasSettings']) ||
    typeof value.autoSave !== 'boolean' ||
    !isDocBlocksAccentColor(value.accentColor)
  ) {
    return null;
  }
  const writeCanvasSettings = parseVscodeWriteCanvasSettings(value.writeCanvasSettings);
  return writeCanvasSettings
    ? { autoSave: value.autoSave, accentColor: value.accentColor, writeCanvasSettings }
    : null;
}

export function isDocBlocksAccentColor(value: unknown): value is DocBlocksAccentColor {
  return DOCBLOCKS_ACCENT_COLORS.some((color) => color === value);
}

export function isDocBlocksWriteCanvasTextSize(value: unknown): value is number {
  return numberInRange(
    value,
    DOCBLOCKS_WRITE_CANVAS_TEXT_SIZE_MIN,
    DOCBLOCKS_WRITE_CANVAS_TEXT_SIZE_MAX,
  );
}

export function isDocBlocksWriteCanvasLineSpacing(value: unknown): value is number {
  return numberInRange(
    value,
    DOCBLOCKS_WRITE_CANVAS_LINE_SPACING_MIN,
    DOCBLOCKS_WRITE_CANVAS_LINE_SPACING_MAX,
  );
}

export function isDocBlocksWriteCanvasFontScheme(
  value: unknown,
): value is DocBlocksWriteCanvasFontScheme {
  return DOCBLOCKS_WRITE_CANVAS_FONT_SCHEMES.some((scheme) => scheme === value);
}

function parseVscodeWriteCanvasSettings(value: unknown): VscodeWriteCanvasSettings | null {
  return isRecord(value) &&
    hasOnlyKeys(value, ['textSize', 'lineSpacing', 'fontScheme']) &&
    isDocBlocksWriteCanvasTextSize(value.textSize) &&
    isDocBlocksWriteCanvasLineSpacing(value.lineSpacing) &&
    isDocBlocksWriteCanvasFontScheme(value.fontScheme)
    ? { textSize: value.textSize, lineSpacing: value.lineSpacing, fontScheme: value.fontScheme }
    : null;
}

function numberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function parseMediaEntries(value: unknown): MediaEntryMessage[] | null {
  if (!Array.isArray(value) || value.length > HOST_WIRE_LIMITS.arrayEntries) return null;
  const entries: MediaEntryMessage[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ['name', 'mimeType', 'size']) ||
      !hasBoundedString(entry, 'name', HOST_WIRE_LIMITS.pathCharacters, 1) ||
      !hasMimeType(entry, 'mimeType') ||
      !hasNonNegativeInteger(entry, 'size') ||
      entry.size > HOST_WIRE_LIMITS.binaryBytes
    ) {
      return null;
    }
    entries.push({ name: entry.name, mimeType: entry.mimeType, size: entry.size });
  }
  return entries;
}

function isBoundedMediaDataUrl(value: unknown): value is string {
  if (!isBoundedString(value, HOST_WIRE_LIMITS.base64Characters + 512, 1)) return false;
  if (!value.startsWith('data:')) return false;
  const separator = value.indexOf(';base64,');
  return separator > 5 && separator <= HOST_WIRE_LIMITS.identifierCharacters;
}

function isDocumentSessionMessageStatus(value: unknown): value is DocumentSessionMessageStatus {
  return (
    value === 'idle' ||
    value === 'saved' ||
    value === 'dirty' ||
    value === 'saving' ||
    value === 'error' ||
    value === 'conflict' ||
    value === 'closed'
  );
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

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
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

function hasNullableSafeFilename<K extends string>(
  value: Record<string, unknown>,
  key: K,
): value is Record<string, unknown> & Record<K, string | null> {
  return value[key] === null || isSafeExportFilename(value[key]);
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
