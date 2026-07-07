/**
 * Handles argv/open-file entry points — translates OS-delivered file paths
 * and docblocks:// URLs into renderer `open-request` events.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { OpenRequest } from '@bendyline/docblocks/host';
import type { BrowserWindow } from 'electron';
import { getWorkspaceRoots, isPathInside } from './workspace-roots.js';

function isLikelyMarkdownFile(candidate: string): boolean {
  if (!candidate) return false;
  if (!candidate.match(/\.(md|markdown|txt)$/i)) return false;
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function toWorkspaceFileRequest(candidate: string): OpenRequest | null {
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

export function resolveOpenUrl(url: string): OpenRequest | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'docblocks:') return null;
    const filePath = parsed.searchParams.get('path');
    return filePath ? toWorkspaceFileRequest(filePath) : null;
  } catch {
    return null;
  }
}

export function resolveOpenRequests(argv: readonly string[]): OpenRequest[] {
  const requests: OpenRequest[] = [];

  for (const arg of argv) {
    if (!arg || typeof arg !== 'string') continue;

    const request = arg.startsWith('docblocks://')
      ? resolveOpenUrl(arg)
      : toWorkspaceFileRequest(arg);
    if (request) requests.push(request);
  }

  return requests;
}

export function sendOpenRequest(win: BrowserWindow, request: OpenRequest): void {
  win.webContents.send('open-request', request);
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
