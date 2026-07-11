/**
 * Handles argv/open-file entry points — translates OS-delivered file paths
 * and docblocks:// URLs into renderer `open-request` events.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { OpenRequest } from '@bendyline/docblocks/host';
import type { BrowserWindow } from 'electron';
import { getWorkspaceRoots, isPathInside } from './workspace-roots.js';
import { grantExternalPath, revokeExternalOwner } from './external-files.js';
import { bindOwnerGrantRevocation } from './owner-revocation.js';

const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd|mdx|txt)$/i;
const BUNDLE_EXT = /\.(dbk|zip)$/i;

export type ResolvedOpenRequest =
  | Extract<OpenRequest, { kind: 'workspace-file' }>
  | { kind: 'external-file'; absolutePath: string; name: string }
  | { kind: 'external-bundle'; absolutePath: string; name: string };

function isExistingFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isLikelyMarkdownFile(candidate: string): boolean {
  if (!candidate) return false;
  if (!candidate.match(MARKDOWN_EXT)) return false;
  return isExistingFile(candidate);
}

function toWorkspaceFileRequest(
  candidate: string,
): Extract<OpenRequest, { kind: 'workspace-file' }> | null {
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
  if (!isLikelyMarkdownFile(absolute)) return null;

  const workspaces = getWorkspaceRoots()
    .list()
    .sort((a, b) => b.rootPath.length - a.rootPath.length);
  const match = workspaces.find((w) => isPathInside(w.rootPath, absolute));
  if (!match) return null;

  const relativePath = path.relative(path.resolve(match.rootPath), absolute).replace(/\\/g, '/');
  if (!relativePath) return null;

  return {
    kind: 'workspace-file',
    workspaceId: match.id,
    path: `/${relativePath.replace(/^\/+/, '')}`,
  };
}

export function resolveOpenUrl(
  url: string,
): Extract<OpenRequest, { kind: 'workspace-file' }> | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'docblocks:') return null;
    const filePath = parsed.searchParams.get('path');
    return filePath ? toWorkspaceFileRequest(filePath) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a plain file path (from argv or the macOS open-file event) into an
 * OpenRequest:
 *   - `.dbk`/`.zip` bundle          → external-bundle (unpacked transiently)
 *   - markdown file inside a workspace → workspace-file
 *   - markdown file elsewhere        → external-file (transient, saved in place)
 * External kinds are added to the session allowlist so the renderer can read
 * their bytes and save back.
 */
function resolveFilePath(candidate: string): ResolvedOpenRequest | null {
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
  if (!isExistingFile(absolute)) return null;
  const name = path.basename(absolute);

  if (BUNDLE_EXT.test(absolute)) {
    return { kind: 'external-bundle', absolutePath: absolute, name };
  }

  if (!MARKDOWN_EXT.test(absolute)) return null;

  const inWorkspace = toWorkspaceFileRequest(absolute);
  if (inWorkspace) return inWorkspace;

  return { kind: 'external-file', absolutePath: absolute, name };
}

export function resolveOpenRequests(argv: readonly string[]): ResolvedOpenRequest[] {
  const requests: ResolvedOpenRequest[] = [];

  for (const arg of argv) {
    if (!arg || typeof arg !== 'string') continue;

    const request = arg.startsWith('docblocks://') ? resolveOpenUrl(arg) : resolveFilePath(arg);
    if (request) requests.push(request);
  }

  return requests;
}

export function sendOpenRequest(win: BrowserWindow, request: ResolvedOpenRequest): void {
  if (request.kind === 'workspace-file') {
    win.webContents.send('open-request', request satisfies OpenRequest);
    return;
  }

  const ownerId = win.webContents.id;
  bindOwnerGrantRevocation(win.webContents, () => revokeExternalOwner(ownerId));
  const publicRequest: OpenRequest = {
    kind: request.kind,
    resourceId: grantExternalPath(ownerId, request.absolutePath),
    name: request.name,
  };
  win.webContents.send('open-request', publicRequest);
}

/**
 * Scan argv for (a) absolute file paths that look like markdown files
 * and (b) docblocks:// URLs, then forward them to the renderer.
 */
export function handleOpenFileArg(win: BrowserWindow, argv: readonly string[]): void {
  for (const request of resolveOpenRequests(argv)) {
    sendOpenRequest(win, request);
  }
}

export function handleOpenUrl(win: BrowserWindow, url: string): void {
  const request = resolveOpenUrl(url);
  if (request) sendOpenRequest(win, request);
}
