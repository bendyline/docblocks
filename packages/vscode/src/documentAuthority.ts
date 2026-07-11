import * as vscode from 'vscode';
import { HOST_WIRE_LIMITS, isBoundedString } from '@bendyline/docblocks/host';
import { mediaSidecarFolder, parseDocumentResourcePath } from './mediaPaths.js';
import { assertBoundedBytes } from './wirePayload.js';

export type AuthorizedDocumentResource =
  | { kind: 'document' }
  | { kind: 'media'; key: string; uri: vscode.Uri };

/**
 * Authorize only the active document itself or a resource in its fixed
 * `<document>_files` sidecar. Workspace descendants are intentionally not an
 * authority boundary.
 */
export function resolveAuthorizedDocumentResource(
  documentUri: vscode.Uri,
  requestedPath: string,
): AuthorizedDocumentResource | null {
  if (!isBoundedString(requestedPath, HOST_WIRE_LIMITS.pathCharacters, 1)) return null;
  const parsed = parseDocumentResourcePath(requestedPath, getUriBasename(documentUri));
  const directory = getDocumentDirectoryUri(documentUri);
  if (!parsed) return null;
  if (parsed.kind === 'document') return parsed;
  if (!directory) return null;
  return {
    kind: 'media',
    key: parsed.key,
    uri: vscode.Uri.joinPath(directory, ...parsed.key.split('/')),
  };
}

export function getDocumentSidecarUri(documentUri: vscode.Uri): vscode.Uri | null {
  const directory = getDocumentDirectoryUri(documentUri);
  if (!directory) return null;
  return vscode.Uri.joinPath(directory, mediaSidecarFolder(getUriBasename(documentUri)));
}

export function getDocumentDirectoryUri(documentUri: vscode.Uri): vscode.Uri | null {
  if (documentUri.scheme === 'untitled') return null;
  const slash = documentUri.path.lastIndexOf('/');
  const directoryPath = slash <= 0 ? '/' : documentUri.path.slice(0, slash);
  return documentUri.with({ path: directoryPath, query: '', fragment: '' });
}

export function getUriBasename(uri: vscode.Uri): string {
  const slash = uri.path.lastIndexOf('/');
  const raw = slash === -1 ? uri.path : uri.path.slice(slash + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Reject symbolic-link or junction components before a privileged local-file
 * operation. VS Code's filesystem API cannot make the subsequent operation
 * atomic with this check, but this closes ordinary lexical-containment escapes
 * and remains compatible with web filesystem providers.
 */
export async function assertNoSymbolicLinkComponents(
  targetUri: vscode.Uri,
  allowMissing = false,
): Promise<void> {
  if (targetUri.scheme !== 'file') return;

  const { rootPath, segments } = splitFilePath(targetUri.path);
  let current = targetUri.with({ path: rootPath, query: '', fragment: '' });
  for (const segment of segments) {
    current = vscode.Uri.joinPath(current, segment);
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(current);
    } catch (error: unknown) {
      if (allowMissing && isFileNotFound(error)) return;
      throw error;
    }
    if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
      throw new Error(`Symbolic links are not permitted for DocBlocks resources: ${segment}`);
    }
  }
}

export async function readAuthorizedMediaFile(uri: vscode.Uri): Promise<Uint8Array | null> {
  try {
    await assertNoSymbolicLinkComponents(uri);
    const stat = await vscode.workspace.fs.stat(uri);
    if (
      (stat.type & vscode.FileType.SymbolicLink) !== 0 ||
      (stat.type & vscode.FileType.File) === 0
    ) {
      throw new Error('The requested DocBlocks resource is not a regular file');
    }
    if (stat.size > HOST_WIRE_LIMITS.binaryBytes) {
      throw new Error('The requested DocBlocks resource exceeds the allowed size');
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    assertBoundedBytes(bytes);
    await assertNoSymbolicLinkComponents(uri);
    const after = await vscode.workspace.fs.stat(uri);
    if (
      after.type !== stat.type ||
      after.size !== stat.size ||
      after.mtime !== stat.mtime ||
      after.ctime !== stat.ctime
    ) {
      throw new Error('The requested DocBlocks resource changed while it was being read');
    }
    return bytes;
  } catch (error: unknown) {
    if (isFileNotFound(error)) return null;
    throw error;
  }
}

export function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof vscode.FileSystemError &&
    (error.code === 'FileNotFound' || error.name === 'EntryNotFound (FileSystemError)')
  );
}

function splitFilePath(path: string): { rootPath: string; segments: string[] } {
  const drive = /^\/([A-Za-z]:)(?:\/|$)/.exec(path);
  if (drive) {
    const rootPath = `/${drive[1]}/`;
    return {
      rootPath,
      segments: path.slice(rootPath.length).split('/').filter(Boolean),
    };
  }
  return { rootPath: '/', segments: path.slice(1).split('/').filter(Boolean) };
}
