import * as vscode from 'vscode';
import { HOST_WIRE_LIMITS } from '@bendyline/docblocks/host';
import type { MediaEntryMessage, WebviewToExtensionMessage } from '@bendyline/docblocks/vscode';
import {
  assertNoSymbolicLinkComponents,
  getDocumentSidecarUri,
  isFileNotFound,
  readAuthorizedMediaFile,
  resolveAuthorizedDocumentResource,
} from './documentAuthority.js';
import { guessMediaMimeType, mediaSidecarFolder } from './mediaPaths.js';
import { assertBoundedBytes, decodeBoundedBase64, encodeBoundedBase64 } from './wirePayload.js';

const MAX_MEDIA_DEPTH = 32;

export type MediaRequestMessage = Extract<
  WebviewToExtensionMessage,
  { type: 'resolveMedia' | 'listMedia' | 'addMedia' | 'removeMedia' }
>;

export function getEditorLocalResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  // Document resources cross the validated message bridge. Exposing the
  // document directory here would let a compromised webview bypass it.
  return [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')];
}

export async function handleMediaMessage(
  msg: MediaRequestMessage,
  document: vscode.TextDocument,
  webview: vscode.Webview,
): Promise<void> {
  switch (msg.type) {
    case 'resolveMedia':
      await postMediaResult(webview, msg.requestId, async () => ({
        type: 'mediaResolved' as const,
        requestId: msg.requestId,
        url: await resolveMediaDataUrl(document.uri, msg.ref),
      }));
      return;

    case 'listMedia':
      await postMediaResult(webview, msg.requestId, async () => ({
        type: 'mediaListed' as const,
        requestId: msg.requestId,
        entries: await listDocumentMedia(document.uri),
      }));
      return;

    case 'addMedia':
      await postMediaResult(webview, msg.requestId, async () => {
        const writtenPath = await writeDocumentMedia(
          document.uri,
          msg.name,
          decodeBoundedBase64(msg.dataBase64),
        );
        return {
          type: 'mediaAdded' as const,
          requestId: msg.requestId,
          path: writtenPath,
        };
      });
      return;

    case 'removeMedia':
      await postMediaResult(webview, msg.requestId, async () => {
        await removeDocumentMedia(document.uri, msg.ref);
        return { type: 'mediaRemoved' as const, requestId: msg.requestId };
      });
      return;

    default:
      assertNever(msg);
  }
}

async function resolveMediaDataUrl(documentUri: vscode.Uri, ref: string): Promise<string> {
  const resource = resolveAuthorizedDocumentResource(documentUri, ref);
  if (!resource || resource.kind !== 'media') {
    throw new Error('The requested media path is outside this document sidecar');
  }
  const bytes = await readAuthorizedMediaFile(resource.uri);
  if (!bytes) throw new Error('The requested media file does not exist');
  return `data:${guessMediaMimeType(resource.key)};base64,${encodeBoundedBase64(bytes)}`;
}

async function listDocumentMedia(documentUri: vscode.Uri): Promise<MediaEntryMessage[]> {
  const sidecarUri = getDocumentSidecarUri(documentUri);
  if (!sidecarUri) return [];

  await assertNoSymbolicLinkComponents(sidecarUri, true);
  const entries: MediaEntryMessage[] = [];
  await walkMediaFolder(sidecarUri, mediaSidecarFolder(getUriBasename(documentUri)), entries, 0);
  return entries;
}

async function writeDocumentMedia(
  documentUri: vscode.Uri,
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  assertBoundedBytes(bytes);
  const resource = resolveAuthorizedDocumentResource(documentUri, name);
  if (!resource || resource.kind !== 'media') {
    throw new Error(`Cannot write media "${name}" outside this document sidecar`);
  }

  await assertNoSymbolicLinkComponents(resource.uri, true);
  await ensureParentDirectory(resource.uri);
  await assertNoSymbolicLinkComponents(resource.uri, true);
  await vscode.workspace.fs.writeFile(resource.uri, bytes);
  return resource.key;
}

async function removeDocumentMedia(documentUri: vscode.Uri, ref: string): Promise<void> {
  const resource = resolveAuthorizedDocumentResource(documentUri, ref);
  if (!resource || resource.kind !== 'media') {
    throw new Error('Cannot remove media outside this document sidecar');
  }

  try {
    await assertNoSymbolicLinkComponents(resource.uri);
    const stat = await vscode.workspace.fs.stat(resource.uri);
    if ((stat.type & vscode.FileType.File) === 0) {
      throw new Error('Only regular DocBlocks media files can be removed');
    }
    await vscode.workspace.fs.delete(resource.uri, { useTrash: false });
  } catch (error: unknown) {
    if (!isFileNotFound(error)) throw error;
  }
}

async function walkMediaFolder(
  folderUri: vscode.Uri,
  relativeFolder: string,
  entries: MediaEntryMessage[],
  depth: number,
): Promise<void> {
  if (depth > MAX_MEDIA_DEPTH) {
    throw new Error('The document media folder exceeds the maximum directory depth');
  }

  await assertNoSymbolicLinkComponents(folderUri);

  let children: [string, vscode.FileType][];
  try {
    children = await vscode.workspace.fs.readDirectory(folderUri);
  } catch (error: unknown) {
    if (isFileNotFound(error)) return;
    throw error;
  }
  if (children.length > HOST_WIRE_LIMITS.arrayEntries) {
    throw new Error('The document media folder contains too many entries');
  }

  for (const [name, type] of children) {
    if (entries.length >= HOST_WIRE_LIMITS.arrayEntries) {
      throw new Error('The document media listing exceeds the allowed size');
    }
    if ((type & vscode.FileType.SymbolicLink) !== 0) {
      throw new Error(`Symbolic links are not permitted in document media: ${name}`);
    }

    const childUri = vscode.Uri.joinPath(folderUri, name);
    const relativePath = `${relativeFolder}/${name}`;
    await assertNoSymbolicLinkComponents(childUri);
    if ((type & vscode.FileType.Directory) !== 0) {
      await walkMediaFolder(childUri, relativePath, entries, depth + 1);
      continue;
    }
    if ((type & vscode.FileType.File) === 0 || relativePath.toLowerCase().endsWith('.md')) {
      continue;
    }

    const stat = await vscode.workspace.fs.stat(childUri);
    if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
      throw new Error(`Symbolic links are not permitted in document media: ${name}`);
    }
    entries.push({
      name: relativePath,
      mimeType: guessMediaMimeType(relativePath),
      size: stat.size,
    });
  }
}

async function ensureParentDirectory(uri: vscode.Uri): Promise<void> {
  const slash = uri.path.lastIndexOf('/');
  if (slash <= 0) return;
  const parent = uri.with({ path: uri.path.slice(0, slash), query: '', fragment: '' });
  await vscode.workspace.fs.createDirectory(parent);
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
  } catch (error: unknown) {
    const message = (error instanceof Error ? error.message : String(error)).slice(
      0,
      HOST_WIRE_LIMITS.messageCharacters,
    );
    await webview.postMessage({ type: 'mediaError', requestId, message });
  }
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

function assertNever(value: never): never {
  throw new Error(`Unhandled media message: ${String(value)}`);
}
