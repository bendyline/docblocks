import * as vscode from 'vscode';
import type { MediaEntryMessage, WebviewToExtensionMessage } from './messages.js';
import { guessMediaMimeType, mediaSidecarFolder, parseMediaRef } from './mediaPaths.js';

export function getEditorLocalResourceRoots(
  extensionUri: vscode.Uri,
  documentUri: vscode.Uri,
): vscode.Uri[] {
  const roots = [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')];
  const documentDirectory = getDocumentDirectoryUri(documentUri);
  if (documentDirectory) roots.push(documentDirectory);
  return roots;
}

export async function handleMediaMessage(
  msg: WebviewToExtensionMessage,
  document: vscode.TextDocument,
  webview: vscode.Webview,
): Promise<boolean> {
  switch (msg.type) {
    case 'resolveMedia':
      await postMediaResult(webview, msg.requestId, async () => ({
        type: 'mediaResolved' as const,
        requestId: msg.requestId,
        url: resolveMediaUrl(document.uri, webview, msg.ref),
      }));
      return true;

    case 'listMedia':
      await postMediaResult(webview, msg.requestId, async () => ({
        type: 'mediaListed' as const,
        requestId: msg.requestId,
        entries: await listDocumentMedia(document.uri),
      }));
      return true;

    case 'addMedia':
      await postMediaResult(webview, msg.requestId, async () => {
        const writtenPath = await writeDocumentMedia(
          document.uri,
          msg.name,
          decodeBase64(msg.dataBase64),
        );
        return {
          type: 'mediaAdded' as const,
          requestId: msg.requestId,
          path: writtenPath,
        };
      });
      return true;

    case 'removeMedia':
      await postMediaResult(webview, msg.requestId, async () => {
        await removeDocumentMedia(document.uri, msg.ref);
        return { type: 'mediaRemoved' as const, requestId: msg.requestId };
      });
      return true;

    default:
      return false;
  }
}

function resolveMediaUrl(documentUri: vscode.Uri, webview: vscode.Webview, ref: string): string {
  const mediaUri = getDocumentMediaUri(documentUri, ref);
  if (!mediaUri) return ref;
  const parsed = parseMediaRef(ref, getUriBasename(documentUri));
  const suffix = parsed?.suffix ?? '';
  return webview.asWebviewUri(mediaUri).toString() + suffix;
}

async function listDocumentMedia(documentUri: vscode.Uri): Promise<MediaEntryMessage[]> {
  const documentDirectory = getDocumentDirectoryUri(documentUri);
  if (!documentDirectory) return [];

  const sidecar = mediaSidecarFolder(getUriBasename(documentUri));
  const sidecarUri = vscode.Uri.joinPath(documentDirectory, sidecar);
  const entries: MediaEntryMessage[] = [];

  await walkMediaFolder(sidecarUri, sidecar, entries);
  return entries;
}

async function writeDocumentMedia(
  documentUri: vscode.Uri,
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  const parsed = parseMediaRef(name, getUriBasename(documentUri));
  const documentDirectory = getDocumentDirectoryUri(documentUri);
  if (!parsed || !documentDirectory) {
    throw new Error(`Cannot write media "${name}" for this document`);
  }

  const targetUri = vscode.Uri.joinPath(documentDirectory, ...parsed.key.split('/'));
  await ensureParentDirectory(targetUri);
  await vscode.workspace.fs.writeFile(targetUri, bytes);
  return parsed.key;
}

async function removeDocumentMedia(documentUri: vscode.Uri, ref: string): Promise<void> {
  const mediaUri = getDocumentMediaUri(documentUri, ref);
  if (!mediaUri) return;
  await vscode.workspace.fs.delete(mediaUri, { useTrash: false });
}

function getDocumentMediaUri(documentUri: vscode.Uri, ref: string): vscode.Uri | null {
  const parsed = parseMediaRef(ref, getUriBasename(documentUri));
  const documentDirectory = getDocumentDirectoryUri(documentUri);
  if (!parsed || !documentDirectory) return null;
  return vscode.Uri.joinPath(documentDirectory, ...parsed.key.split('/'));
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

async function walkMediaFolder(
  folderUri: vscode.Uri,
  relativeFolder: string,
  entries: MediaEntryMessage[],
): Promise<void> {
  let children: [string, vscode.FileType][];
  try {
    children = await vscode.workspace.fs.readDirectory(folderUri);
  } catch {
    return;
  }

  for (const [name, type] of children) {
    const childUri = vscode.Uri.joinPath(folderUri, name);
    const relativePath = `${relativeFolder}/${name}`;
    if (type === vscode.FileType.Directory) {
      await walkMediaFolder(childUri, relativePath, entries);
      continue;
    }
    if (type !== vscode.FileType.File || relativePath.toLowerCase().endsWith('.md')) continue;

    let size = 0;
    try {
      size = (await vscode.workspace.fs.stat(childUri)).size;
    } catch {
      size = 0;
    }

    entries.push({
      name: relativePath,
      mimeType: guessMediaMimeType(relativePath),
      size,
    });
  }
}

async function ensureParentDirectory(uri: vscode.Uri): Promise<void> {
  const slash = uri.path.lastIndexOf('/');
  if (slash <= 0) return;
  const parent = uri.with({ path: uri.path.slice(0, slash), query: '', fragment: '' });
  await vscode.workspace.fs.createDirectory(parent);
}

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function postMediaResult(
  webview: vscode.Webview,
  requestId: number,
  createMessage: () => Promise<
    | { type: 'mediaResolved'; requestId: number; url: string }
    | { type: 'mediaListed'; requestId: number; entries: MediaEntryMessage[] }
    | { type: 'mediaAdded'; requestId: number; path: string }
    | { type: 'mediaRemoved'; requestId: number }
  >,
): Promise<void> {
  try {
    await webview.postMessage(await createMessage());
  } catch (error) {
    await webview.postMessage({
      type: 'mediaError',
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
