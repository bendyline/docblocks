/**
 * Handles argv/open-file entry points — translates OS-delivered file paths
 * and docblocks:// URLs into renderer `open-request` events.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';

function isLikelyMarkdownFile(candidate: string): boolean {
  if (!candidate) return false;
  if (!candidate.match(/\.(md|markdown|txt)$/i)) return false;
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Scan argv for (a) absolute file paths that look like markdown files
 * and (b) docblocks:// URLs, then forward them to the renderer.
 */
export function handleOpenFileArg(win: BrowserWindow, argv: readonly string[]): void {
  for (const arg of argv) {
    if (!arg || typeof arg !== 'string') continue;

    if (arg.startsWith('docblocks://')) {
      win.webContents.send('open-request', { url: arg });
      continue;
    }

    // Resolve relative to the app's cwd — Electron launches from varied places.
    const absolute = path.isAbsolute(arg) ? arg : path.resolve(arg);
    if (isLikelyMarkdownFile(absolute)) {
      win.webContents.send('open-request', { filePath: absolute });
    }
  }
}
