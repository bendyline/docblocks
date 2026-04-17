/**
 * macOS-only: detect whether the user's ~/Documents folder is being managed
 * by iCloud Drive. A managed Documents folder can return EIO for not-yet-
 * materialized placeholder files and triggers surprise sync behavior.
 *
 * The heuristic checks two things:
 *   1. The iCloud CloudDocs container exists at the canonical path.
 *   2. ~/Documents has a `.com.apple.mobile_container_manager.metadata.plist`
 *      marker OR is a symlink into Mobile Documents.
 *
 * Not perfect, but good enough to offer a one-time nudge to use ~/DocBlocks.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function isMacOSDocumentsICloudManaged(): boolean {
  if (process.platform !== 'darwin') return false;

  const home = os.homedir();
  const documentsPath = path.join(home, 'Documents');
  const cloudDocsPath = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');

  if (!fs.existsSync(cloudDocsPath)) {
    return false;
  }

  // If Documents is a symlink anywhere into Mobile Documents, iCloud manages it.
  try {
    const realDocs = fs.realpathSync(documentsPath);
    if (realDocs.includes('/Mobile Documents/')) {
      return true;
    }
  } catch {
    // ignore
  }

  // Look for the iCloud metadata plist marker inside ~/Documents.
  try {
    const marker = path.join(documentsPath, '.com.apple.mobile_container_manager.metadata.plist');
    if (fs.existsSync(marker)) return true;
  } catch {
    // ignore
  }

  return false;
}

/**
 * Suggested default workspace root taking iCloud into account.
 * Returns ~/Documents/DocBlocks unless we detect iCloud + haven't asked yet,
 * in which case the caller should prompt the user.
 */
export function suggestedDefaultRoot(): string {
  return path.join(os.homedir(), 'Documents', 'DocBlocks');
}

export function iCloudAlternativeRoot(): string {
  return path.join(os.homedir(), 'DocBlocks');
}
