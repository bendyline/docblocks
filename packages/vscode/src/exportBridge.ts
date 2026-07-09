import * as vscode from 'vscode';
import type { WebviewToExtensionMessage } from './messages.js';
import { parseMediaRef } from './mediaPaths.js';

type ExportBridgeResponseMessage =
  | { type: 'exportSaved'; requestId: number; uri: string | null; path: string | null }
  | { type: 'exportTargetResolved'; requestId: number; path: string }
  | { type: 'exportTargetPicked'; requestId: number; path: string | null }
  | { type: 'workspaceFileRead'; requestId: number; dataBase64: string | null };

type ExportBridgeErrorType = 'exportError' | 'workspaceFileError';

interface StoredExportTarget {
  lastUri?: string;
  byExtension?: Record<string, string>;
}

const EXPORT_TARGET_STORAGE_PREFIX = 'docblocks.exportTarget.v1:';

export async function handleExportMessage(
  msg: WebviewToExtensionMessage,
  document: vscode.TextDocument,
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
): Promise<boolean> {
  switch (msg.type) {
    case 'saveExport':
      await postExportResult(webview, msg.requestId, 'exportError', async () => {
        const requestedPath = msg.targetPath?.trim() ?? '';
        const requestedTarget = requestedPath
          ? resolveExportTargetPath(document.uri, requestedPath)
          : null;
        if (requestedPath && !requestedTarget) {
          throw new Error(
            'Could not resolve export path. Choose a location or use an absolute path.',
          );
        }

        const target =
          requestedTarget ??
          (await vscode.window.showSaveDialog({
            defaultUri: getDefaultExportUri(context, document.uri, msg.filename),
            filters: getSaveFilters(msg.filename),
          }));
        if (!target) {
          return { type: 'exportSaved' as const, requestId: msg.requestId, uri: null, path: null };
        }

        await vscode.workspace.fs.writeFile(target, decodeBase64(msg.dataBase64));
        await rememberExportTarget(context, document.uri, target);
        return {
          type: 'exportSaved' as const,
          requestId: msg.requestId,
          uri: target.toString(),
          path: pathForDisplay(target),
        };
      });
      return true;

    case 'resolveExportTarget':
      await postExportResult(webview, msg.requestId, 'exportError', async () => {
        const target = getDefaultExportUri(context, document.uri, msg.filename);
        return {
          type: 'exportTargetResolved' as const,
          requestId: msg.requestId,
          path: target ? pathForDisplay(target) : sanitizeFilename(msg.filename),
        };
      });
      return true;

    case 'pickExportTarget':
      await postExportResult(webview, msg.requestId, 'exportError', async () => {
        const currentTarget = msg.currentPath
          ? resolveExportTargetPath(document.uri, msg.currentPath)
          : null;
        const target = await vscode.window.showSaveDialog({
          defaultUri: currentTarget ?? getDefaultExportUri(context, document.uri, msg.filename),
          filters: getSaveFilters(msg.filename),
        });
        if (!target) {
          return { type: 'exportTargetPicked' as const, requestId: msg.requestId, path: null };
        }

        await rememberExportTarget(context, document.uri, target);
        return {
          type: 'exportTargetPicked' as const,
          requestId: msg.requestId,
          path: pathForDisplay(target),
        };
      });
      return true;

    case 'readWorkspaceFile':
      await postExportResult(webview, msg.requestId, 'workspaceFileError', async () => {
        const bytes = await readContainerFile(document.uri, msg.path);
        return {
          type: 'workspaceFileRead' as const,
          requestId: msg.requestId,
          dataBase64: bytes ? encodeBase64(bytes) : null,
        };
      });
      return true;

    default:
      return false;
  }
}

async function readContainerFile(
  documentUri: vscode.Uri,
  requestedPath: string,
): Promise<Uint8Array | null> {
  const primaryUri = resolveContainerUri(documentUri, requestedPath);
  if (primaryUri) {
    const primary = await tryReadFile(primaryUri);
    if (primary) return primary;
  }

  if (isMarkdownPath(requestedPath)) return null;

  const parsedMedia = parseMediaRef(requestedPath, getUriBasename(documentUri));
  if (!parsedMedia) return null;

  const mediaUri = resolveContainerUri(documentUri, parsedMedia.key);
  if (!mediaUri || mediaUri.toString() === primaryUri?.toString()) return null;
  return tryReadFile(mediaUri);
}

async function tryReadFile(uri: vscode.Uri): Promise<Uint8Array | null> {
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch {
    return null;
  }
}

function resolveContainerUri(documentUri: vscode.Uri, requestedPath: string): vscode.Uri | null {
  if (documentUri.scheme === 'untitled') return null;

  const documentDirectory = getDocumentDirectoryUri(documentUri);
  if (!documentDirectory) return null;

  const segments = parseContainerPath(requestedPath);
  if (!segments) return null;

  const targetUri = vscode.Uri.joinPath(documentDirectory, ...segments);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
  const allowedRoot = workspaceFolder?.uri ?? documentDirectory;
  if (!isSameRoot(targetUri, allowedRoot)) return null;
  if (!isPathWithin(targetUri.path, allowedRoot.path)) return null;

  return targetUri;
}

function parseContainerPath(value: string): string[] | null {
  const pathPart = value.split(/[?#]/, 1)[0] ?? value;
  const normalized = pathPart.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return null;

  const segments: string[] = [];
  for (const rawSegment of normalized.split('/')) {
    if (!rawSegment || rawSegment === '.') continue;
    const segment = decodeSegment(rawSegment);
    if (!isSafeSegment(segment)) return null;
    segments.push(segment);
  }
  return segments.length > 0 ? segments : null;
}

function isSafeSegment(segment: string): boolean {
  return segment !== '' && segment !== '.' && !/[\\/\0]/.test(segment);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
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
  return (
    context.workspaceState.get<StoredExportTarget>(getExportTargetStorageKey(documentUri)) ?? {}
  );
}

async function rememberExportTarget(
  context: vscode.ExtensionContext,
  documentUri: vscode.Uri,
  targetUri: vscode.Uri,
): Promise<void> {
  const stored = readStoredExportTarget(context, documentUri);
  const byExtension = { ...(stored.byExtension ?? {}) };
  const extension = getExtension(getUriBasename(targetUri));
  if (extension) byExtension[extension] = targetUri.toString();

  await context.workspaceState.update(getExportTargetStorageKey(documentUri), {
    lastUri: targetUri.toString(),
    byExtension,
  } satisfies StoredExportTarget);
}

function getExportTargetStorageKey(documentUri: vscode.Uri): string {
  return `${EXPORT_TARGET_STORAGE_PREFIX}${encodeURIComponent(documentUri.toString())}`;
}

function resolveExportTargetPath(documentUri: vscode.Uri, value: string): vscode.Uri | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  if (isWindowsDrivePath(trimmed) && !isWindowsAbsolutePath(trimmed)) return null;
  if (hasUriScheme(trimmed)) return tryParseUri(trimmed);
  if (isWindowsAbsolutePath(trimmed) || isUncPath(trimmed)) return vscode.Uri.file(trimmed);

  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    if (documentUri.scheme === 'file') return vscode.Uri.file(trimmed);
    return documentUri.with({ path: normalized, query: '', fragment: '' });
  }

  const documentDirectory = getDocumentDirectoryUri(documentUri);
  if (!documentDirectory) return null;

  const segments = parseRelativeExportPath(trimmed);
  if (!segments) return null;
  return vscode.Uri.joinPath(documentDirectory, ...segments);
}

function parseRelativeExportPath(value: string): string[] | null {
  const normalized = value.replace(/\\/g, '/');
  const segments: string[] = [];
  for (const rawSegment of normalized.split('/')) {
    if (!rawSegment || rawSegment === '.') continue;
    const segment = decodeSegment(rawSegment);
    if (segment === '..' || !isSafeSegment(segment)) return null;
    segments.push(segment);
  }
  return segments.length > 0 ? segments : null;
}

function pathForDisplay(uri: vscode.Uri): string {
  return uri.scheme === 'file' ? uri.fsPath : uri.toString();
}

function tryParseUri(value: string): vscode.Uri | null {
  try {
    return vscode.Uri.parse(value);
  } catch {
    return null;
  }
}

function hasUriScheme(value: string): boolean {
  return !isWindowsDrivePath(value) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function isWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:/.test(value);
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function isUncPath(value: string): boolean {
  return value.startsWith('\\\\');
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
  return filename.slice(dot + 1).toLowerCase();
}

function isMarkdownPath(path: string): boolean {
  const cleanPath = path.split(/[?#]/, 1)[0] ?? path;
  return cleanPath.toLowerCase().endsWith('.md');
}

function getDocumentDirectoryUri(documentUri: vscode.Uri): vscode.Uri | null {
  if (documentUri.scheme === 'untitled') return null;
  const slash = documentUri.path.lastIndexOf('/');
  const directoryPath = slash <= 0 ? '/' : documentUri.path.slice(0, slash);
  return documentUri.with({ path: directoryPath, query: '', fragment: '' });
}

function getUriBasename(uri: vscode.Uri): string {
  const slash = uri.path.lastIndexOf('/');
  const raw = slash === -1 ? uri.path : uri.path.slice(slash + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function sanitizeFilename(filename: string): string {
  const clean = filename.replace(/[\\/\0]/g, '-').trim();
  return clean || 'document';
}

function isSameRoot(uri: vscode.Uri, root: vscode.Uri): boolean {
  return uri.scheme === root.scheme && uri.authority === root.authority;
}

function isPathWithin(path: string, rootPath: string): boolean {
  const normalizedRoot = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
  return path === rootPath || path.startsWith(normalizedRoot);
}

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return globalThis.btoa(binary);
}

async function postExportResult(
  webview: vscode.Webview,
  requestId: number,
  errorType: ExportBridgeErrorType,
  createMessage: () => Promise<ExportBridgeResponseMessage>,
): Promise<void> {
  try {
    await webview.postMessage(await createMessage());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await vscode.window.showErrorMessage(message);
    await webview.postMessage({ type: errorType, requestId, message });
  }
}
