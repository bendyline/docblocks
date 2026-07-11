import * as vscode from 'vscode';
import { HOST_WIRE_LIMITS, isBoundedString } from '@bendyline/docblocks/host';
import {
  resolveAuthorizedDocumentResource,
  assertNoSymbolicLinkComponents,
  getDocumentDirectoryUri,
  getUriBasename,
  readAuthorizedMediaFile,
} from './documentAuthority.js';
import type { ExportGrantScope, ExportTargetGrantRegistry } from './exportGrants.js';
import type { ExportTargetGrantMessage, WebviewToExtensionMessage } from './messages.js';
import { decodeBoundedBase64, encodeBoundedBase64 } from './wirePayload.js';

export type ExportRequestMessage = Extract<
  WebviewToExtensionMessage,
  {
    type: 'saveExport' | 'resolveExportTarget' | 'pickExportTarget' | 'readWorkspaceFile';
  }
>;

type ExportBridgeResponseMessage =
  | { type: 'exportSaved'; requestId: number; target: ExportTargetGrantMessage | null }
  | {
      type: 'exportTargetResolved';
      requestId: number;
      target: ExportTargetGrantMessage | null;
    }
  | { type: 'exportTargetPicked'; requestId: number; target: ExportTargetGrantMessage | null }
  | { type: 'workspaceFileRead'; requestId: number; dataBase64: string | null };

type ExportBridgeErrorType = 'exportError' | 'workspaceFileError';

interface StoredExportTarget {
  lastUri?: string;
  byExtension?: Record<string, string>;
}

export interface ExportAuthority {
  grants: ExportTargetGrantRegistry<vscode.Uri>;
  scope: ExportGrantScope;
}

const EXPORT_TARGET_STORAGE_PREFIX = 'docblocks.exportTarget.v2:';

export async function handleExportMessage(
  msg: ExportRequestMessage,
  document: vscode.TextDocument,
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  authority: ExportAuthority,
): Promise<void> {
  switch (msg.type) {
    case 'saveExport':
      await postExportResult(webview, msg.requestId, 'exportError', async () => {
        const bytes = decodeBoundedBase64(msg.dataBase64);
        let target: vscode.Uri | undefined;
        if (msg.grantId) {
          target = authority.grants.consume(authority.scope, msg.grantId);
        } else {
          target = await vscode.window.showSaveDialog({
            defaultUri: getDefaultExportUri(context, document.uri, msg.filename),
            filters: getSaveFilters(msg.filename),
          });
        }

        if (!target) {
          return { type: 'exportSaved' as const, requestId: msg.requestId, target: null };
        }

        await assertNoSymbolicLinkComponents(target, true);
        await vscode.workspace.fs.writeFile(target, bytes);
        await assertNoSymbolicLinkComponents(target);
        await rememberExportTarget(context, document.uri, target);
        return {
          type: 'exportSaved' as const,
          requestId: msg.requestId,
          target: issueGrant(authority, target),
        };
      });
      return;

    case 'resolveExportTarget':
      await postExportResult(webview, msg.requestId, 'exportError', async () => {
        const target = getDefaultExportUri(context, document.uri, msg.filename);
        return {
          type: 'exportTargetResolved' as const,
          requestId: msg.requestId,
          target: target ? issueGrant(authority, target) : null,
        };
      });
      return;

    case 'pickExportTarget':
      await postExportResult(webview, msg.requestId, 'exportError', async () => {
        const currentTarget = msg.currentGrantId
          ? authority.grants.peek(authority.scope, msg.currentGrantId)
          : undefined;
        const target = await vscode.window.showSaveDialog({
          defaultUri: currentTarget ?? getDefaultExportUri(context, document.uri, msg.filename),
          filters: getSaveFilters(msg.filename),
        });
        if (!target) {
          return { type: 'exportTargetPicked' as const, requestId: msg.requestId, target: null };
        }

        if (msg.currentGrantId) authority.grants.revoke(authority.scope, msg.currentGrantId);
        await rememberExportTarget(context, document.uri, target);
        return {
          type: 'exportTargetPicked' as const,
          requestId: msg.requestId,
          target: issueGrant(authority, target),
        };
      });
      return;

    case 'readWorkspaceFile':
      await postExportResult(webview, msg.requestId, 'workspaceFileError', async () => {
        const bytes = await readContainerFile(document, msg.path);
        return {
          type: 'workspaceFileRead' as const,
          requestId: msg.requestId,
          dataBase64: bytes ? encodeBoundedBase64(bytes) : null,
        };
      });
      return;

    default:
      assertNever(msg);
  }
}

async function readContainerFile(
  document: vscode.TextDocument,
  requestedPath: string,
): Promise<Uint8Array | null> {
  const resource = resolveAuthorizedDocumentResource(document.uri, requestedPath);
  if (!resource) return null;
  if (resource.kind === 'document') return new TextEncoder().encode(document.getText());
  return readAuthorizedMediaFile(resource.uri);
}

function issueGrant(authority: ExportAuthority, target: vscode.Uri): ExportTargetGrantMessage {
  return authority.grants.issue(authority.scope, target, pathForDisplay(target));
}

function getDefaultExportUri(
  context: vscode.ExtensionContext,
  documentUri: vscode.Uri,
  filename: string,
): vscode.Uri | undefined {
  const remembered = getRememberedExportUri(context, documentUri, filename);
  if (remembered) return remembered;

  const documentDirectory = getDocumentDirectoryUri(documentUri);
  if (!documentDirectory) return undefined;
  return vscode.Uri.joinPath(documentDirectory, sanitizeFilename(filename));
}

function getRememberedExportUri(
  context: vscode.ExtensionContext,
  documentUri: vscode.Uri,
  filename: string,
): vscode.Uri | null {
  const stored = readStoredExportTarget(context, documentUri);
  const extension = getExtension(filename);
  const storedForExtension = extension ? stored.byExtension?.[extension] : undefined;
  const exactTarget = storedForExtension ? tryParseUri(storedForExtension) : null;
  if (exactTarget) return exactTarget;

  const lastTarget = stored.lastUri ? tryParseUri(stored.lastUri) : null;
  if (!lastTarget) return null;

  const lastDirectory = getDocumentDirectoryUri(lastTarget);
  if (!lastDirectory) return lastTarget;
  return vscode.Uri.joinPath(lastDirectory, sanitizeFilename(filename));
}

function readStoredExportTarget(
  context: vscode.ExtensionContext,
  documentUri: vscode.Uri,
): StoredExportTarget {
  const stored = context.workspaceState.get<unknown>(getExportTargetStorageKey(documentUri));
  if (!isRecord(stored)) return {};

  const result: StoredExportTarget = {};
  if (isBoundedString(stored.lastUri, HOST_WIRE_LIMITS.urlCharacters, 1)) {
    result.lastUri = stored.lastUri;
  }
  if (isRecord(stored.byExtension)) {
    const entries = Object.entries(stored.byExtension).slice(0, 64);
    const byExtension: Record<string, string> = {};
    for (const [extension, uri] of entries) {
      if (
        /^[a-z0-9]{1,16}$/.test(extension) &&
        isBoundedString(uri, HOST_WIRE_LIMITS.urlCharacters, 1)
      ) {
        byExtension[extension] = uri;
      }
    }
    result.byExtension = byExtension;
  }
  return result;
}

async function rememberExportTarget(
  context: vscode.ExtensionContext,
  documentUri: vscode.Uri,
  targetUri: vscode.Uri,
): Promise<void> {
  const serialized = targetUri.toString();
  if (!isBoundedString(serialized, HOST_WIRE_LIMITS.urlCharacters, 1)) {
    throw new Error('The selected export target is too long');
  }
  const stored = readStoredExportTarget(context, documentUri);
  const byExtension = { ...(stored.byExtension ?? {}) };
  const extension = getExtension(getUriBasename(targetUri));
  if (extension) byExtension[extension] = serialized;

  await context.workspaceState.update(getExportTargetStorageKey(documentUri), {
    lastUri: serialized,
    byExtension,
  } satisfies StoredExportTarget);
}

function getExportTargetStorageKey(documentUri: vscode.Uri): string {
  return `${EXPORT_TARGET_STORAGE_PREFIX}${encodeURIComponent(documentUri.toString())}`;
}

function pathForDisplay(uri: vscode.Uri): string {
  const label = uri.scheme === 'file' ? uri.fsPath : uri.toString();
  if (!isBoundedString(label, HOST_WIRE_LIMITS.pathCharacters, 1)) {
    throw new Error('The selected export target label is too long');
  }
  return label;
}

function tryParseUri(value: string): vscode.Uri | null {
  if (!isBoundedString(value, HOST_WIRE_LIMITS.urlCharacters, 1)) return null;
  try {
    const uri = vscode.Uri.parse(value, true);
    return uri.scheme ? uri : null;
  } catch {
    return null;
  }
}

function getSaveFilters(filename: string): Record<string, string[]> | undefined {
  const extension = getExtension(filename);
  if (!extension) return undefined;
  const label = extensionLabel(extension);
  return { [label]: [extension] };
}

function extensionLabel(extension: string): string {
  switch (extension) {
    case 'docx':
      return 'Word Document';
    case 'pdf':
      return 'PDF';
    case 'pptx':
      return 'PowerPoint';
    case 'html':
      return 'HTML';
    case 'md':
      return 'Markdown';
    case 'zip':
      return 'ZIP Archive';
    default:
      return `${extension.toUpperCase()} File`;
  }
}

function getExtension(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || dot === filename.length - 1) return null;
  const extension = filename.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(extension) ? extension : null;
}

function sanitizeFilename(filename: string): string {
  const clean = filename.replace(/[\\/\0]/g, '-').trim();
  return clean || 'document';
}

async function postExportResult(
  webview: vscode.Webview,
  requestId: number,
  errorType: ExportBridgeErrorType,
  createMessage: () => Promise<ExportBridgeResponseMessage>,
): Promise<void> {
  try {
    await webview.postMessage(await createMessage());
  } catch (error: unknown) {
    const message = boundedErrorMessage(error);
    await vscode.window.showErrorMessage(message);
    await webview.postMessage({ type: errorType, requestId, message });
  }
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, HOST_WIRE_LIMITS.messageCharacters);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled export message: ${String(value)}`);
}
