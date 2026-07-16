import * as vscode from 'vscode';
import { HOST_WIRE_LIMITS, isBoundedString } from '@bendyline/docblocks/host';
import type {
  ExportTargetGrantMessage,
  WebviewToExtensionMessage,
} from '@bendyline/docblocks/vscode';
import {
  resolveAuthorizedDocumentResource,
  assertNoSymbolicLinkComponents,
  getDocumentDirectoryUri,
  getUriBasename,
  isFileNotFound,
  readAuthorizedMediaFile,
} from './documentAuthority.js';
import type { ExportGrantScope, ExportTargetGrantRegistry } from './exportGrants.js';
import {
  getAllowedExportExtension,
  isMatchingExportTargetFilename,
  parseStoredExportTarget,
  selectRememberedExactExportTarget,
  type StoredExportTarget,
} from './exportTargetPolicy.js';
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
        const requestedFilename = validateRequestedFilename(msg.filename, msg.targetFilename);
        let target: vscode.Uri | undefined;
        if (msg.grantId) {
          if (msg.targetFilename) {
            const grantedTarget = authority.grants.peek(authority.scope, msg.grantId);
            target = await applyEditedFilename(grantedTarget, msg.targetFilename, msg.filename);
            if (!target) {
              return { type: 'exportSaved' as const, requestId: msg.requestId, target: null };
            }
            authority.grants.consume(authority.scope, msg.grantId);
          } else {
            target = authority.grants.consume(authority.scope, msg.grantId);
          }
        } else {
          target = await vscode.window.showSaveDialog({
            defaultUri: getDialogDefaultExportUri(context, document.uri, requestedFilename),
            filters: getSaveFilters(requestedFilename),
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
        const target = getRememberedExactExportUri(context, document.uri, msg.filename);
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
          defaultUri:
            currentTarget ?? getDialogDefaultExportUri(context, document.uri, msg.filename),
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

function validateRequestedFilename(
  generatedFilename: string,
  editedFilename: string | null,
): string {
  if (editedFilename === null) return generatedFilename;
  if (!isMatchingExportTargetFilename(generatedFilename, editedFilename)) {
    throw new Error('The edited export filename must use the selected format extension');
  }
  return editedFilename;
}

async function applyEditedFilename(
  grantedTarget: vscode.Uri,
  editedFilename: string | null,
  generatedFilename: string,
): Promise<vscode.Uri | undefined> {
  if (editedFilename === null || editedFilename === getUriBasename(grantedTarget)) {
    return grantedTarget;
  }

  validateRequestedFilename(generatedFilename, editedFilename);
  const directory = getDocumentDirectoryUri(grantedTarget);
  if (!directory) throw new Error('The selected export target cannot be renamed');
  const editedTarget = vscode.Uri.joinPath(directory, editedFilename);

  if (!(await exportTargetExists(editedTarget))) return editedTarget;
  return vscode.window.showSaveDialog({
    defaultUri: editedTarget,
    filters: getSaveFilters(editedFilename),
  });
}

async function exportTargetExists(target: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(target);
    return true;
  } catch (error: unknown) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
}

function getDialogDefaultExportUri(
  context: vscode.ExtensionContext,
  documentUri: vscode.Uri,
  filename: string,
): vscode.Uri | undefined {
  const remembered = getRememberedExactExportUri(context, documentUri, filename);
  if (remembered) return remembered;

  const stored = readStoredExportTarget(context, documentUri);
  const lastTarget = stored.lastUri ? tryParseUri(stored.lastUri) : null;
  if (lastTarget) {
    const lastDirectory = getDocumentDirectoryUri(lastTarget);
    if (lastDirectory) return vscode.Uri.joinPath(lastDirectory, sanitizeFilename(filename));
  }

  const documentDirectory = getDocumentDirectoryUri(documentUri);
  if (!documentDirectory) return undefined;
  return vscode.Uri.joinPath(documentDirectory, sanitizeFilename(filename));
}

function getRememberedExactExportUri(
  context: vscode.ExtensionContext,
  documentUri: vscode.Uri,
  filename: string,
): vscode.Uri | null {
  const stored = context.workspaceState.get<unknown>(getExportTargetStorageKey(documentUri));
  const serialized = selectRememberedExactExportTarget(stored, filename);
  return serialized ? tryParseUri(serialized) : null;
}

function readStoredExportTarget(
  context: vscode.ExtensionContext,
  documentUri: vscode.Uri,
): StoredExportTarget {
  return parseStoredExportTarget(
    context.workspaceState.get<unknown>(getExportTargetStorageKey(documentUri)),
  );
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
  const extension = getAllowedExportExtension(getUriBasename(targetUri));
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
  const extension = getAllowedExportExtension(filename);
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
    case 'epub':
      return 'EPUB e-book';
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

function assertNever(value: never): never {
  throw new Error(`Unhandled export message: ${String(value)}`);
}
