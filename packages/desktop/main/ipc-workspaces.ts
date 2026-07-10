/**
 * IPC handlers for workspace management — default folder, picker, register.
 */

import { app, ipcMain, dialog, BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ElectronWorkspaceInfo } from '@bendyline/docblocks/host';

import { getWorkspaceRoots } from './workspace-roots.js';
import { updateSettings, readSettings } from './settings.js';
import { isSandboxed } from './security-scoped.js';
import {
  isMacOSDocumentsICloudManaged,
  suggestedDefaultRoot,
  iCloudAlternativeRoot,
} from './icloud-detect.js';

function deriveWorkspaceId(rootPath: string): string {
  const base = path.basename(rootPath) || 'workspace';
  const safeBase = base.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `electron-${safeBase}-${Buffer.from(rootPath).toString('hex').slice(0, 12)}`;
}

function normaliseTrustPath(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function ensureFolder(absPath: string): Promise<void> {
  await fs.mkdir(absPath, { recursive: true });
}

/**
 * Trust + persist a folder as a workspace root: register it in the fs
 * whitelist and upsert it into settings so it survives relaunch. Shared by
 * the folder picker and the git clone flow.
 */
export async function registerAndPersistWorkspace(
  rootPath: string,
  bookmark?: string,
): Promise<ElectronWorkspaceInfo> {
  const id = deriveWorkspaceId(rootPath);
  const name = path.basename(rootPath) || 'Folder';
  getWorkspaceRoots().register(id, rootPath);

  await updateSettings((s) => {
    const existing = s.workspaces.find((w) => w.id === id);
    if (existing) {
      // Refresh the bookmark — they can go stale, and re-picking renews it.
      if (bookmark) existing.bookmark = bookmark;
    } else {
      s.workspaces.push({ id, name, rootPath, ...(bookmark ? { bookmark } : {}) });
    }
    return s;
  });

  return { id, name, rootPath };
}

export function registerWorkspaceIpc(): void {
  const roots = getWorkspaceRoots();

  ipcMain.handle('workspaces:getDefault', async (event): Promise<ElectronWorkspaceInfo> => {
    const settings = await readSettings();

    // E2E override — tests pass an isolated workspace dir so they don't
    // touch DocBlocks inside the real OS Documents folder. Wins over saved defaults.
    const e2eRoot = process.env.DOCBLOCKS_E2E_DEFAULT_ROOT;
    if (e2eRoot) {
      await ensureFolder(e2eRoot);
      const id = deriveWorkspaceId(e2eRoot);
      roots.register(id, e2eRoot);
      return { id, name: path.basename(e2eRoot) || 'DocBlocks', rootPath: e2eRoot };
    }

    // Honour a previously configured default.
    if (settings.defaultWorkspaceRoot) {
      const rootPath = settings.defaultWorkspaceRoot;
      await ensureFolder(rootPath);
      const id = deriveWorkspaceId(rootPath);
      roots.register(id, rootPath);
      await updateSettings((s) => {
        if (!s.workspaces.some((w) => w.id === id)) {
          s.workspaces.push({ id, name: path.basename(rootPath) || 'DocBlocks', rootPath });
        }
        return s;
      });
      return { id, name: path.basename(rootPath) || 'DocBlocks', rootPath };
    }

    // Ask the operating system for its Documents known folder instead of
    // constructing ~/Documents. This honors redirected locations such as
    // OneDrive Documents on Windows.
    const documentsPath = app.getPath('documents');

    // Mac App Store sandbox: the app can only freely write inside its own
    // container. `app.getPath('documents')` is redirected there by the sandbox,
    // so it's the one default that needs no user grant. Other folders are
    // reached via the picker, which mints a security-scoped bookmark. (The
    // iCloud nudge below is irrelevant inside the container.)
    if (isSandboxed()) {
      const root = suggestedDefaultRoot(documentsPath);
      await ensureFolder(root);
      const id = deriveWorkspaceId(root);
      const name = path.basename(root) || 'DocBlocks';
      roots.register(id, root);
      await updateSettings((s) => {
        const next = { ...s, defaultWorkspaceRoot: root };
        if (!next.workspaces.some((w) => w.id === id)) {
          next.workspaces.push({ id, name, rootPath: root });
        }
        return next;
      });
      return { id, name, rootPath: root };
    }

    // First launch — consider iCloud on macOS and give the user one prompt.
    let chosenRoot = suggestedDefaultRoot(documentsPath);
    if (
      process.platform === 'darwin' &&
      isMacOSDocumentsICloudManaged(documentsPath) &&
      !settings.iCloudPromptShown
    ) {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const answer = await dialog.showMessageBox(win!, {
        type: 'question',
        buttons: ['Use ~/Documents/DocBlocks', 'Use ~/DocBlocks (local only)', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        title: 'iCloud-synced Documents detected',
        message: 'Your ~/Documents folder is synced to iCloud Drive.',
        detail:
          'DocBlocks stores files on your computer. If you use ~/Documents/DocBlocks, your files will also sync to iCloud — which can cause sync delays and conflicts. Using ~/DocBlocks keeps files local to this Mac.',
      });
      if (answer.response === 1) chosenRoot = iCloudAlternativeRoot();
      if (answer.response === 2) throw new Error('Setup cancelled');
      await updateSettings((s) => ({ ...s, iCloudPromptShown: true }));
    }

    await ensureFolder(chosenRoot);
    const id = deriveWorkspaceId(chosenRoot);
    const name = path.basename(chosenRoot) || 'DocBlocks';
    roots.register(id, chosenRoot);

    await updateSettings((s) => {
      const next = { ...s, defaultWorkspaceRoot: chosenRoot };
      if (!next.workspaces.some((w) => w.id === id)) {
        next.workspaces.push({ id, name, rootPath: chosenRoot });
      }
      return next;
    });

    return { id, name, rootPath: chosenRoot };
  });

  ipcMain.handle('workspaces:pickFolder', async (event): Promise<ElectronWorkspaceInfo | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win!, {
      title: 'Open folder',
      properties: ['openDirectory', 'createDirectory'],
      // MAS only: mint a security-scoped bookmark so we can regain access to
      // this folder after a relaunch. Empty/undefined in non-sandboxed builds.
      securityScopedBookmarks: isSandboxed(),
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const rootPath = result.filePaths[0];
    // The dialog already grants access for this session; the bookmark is what
    // restores it next launch (consumed in main.ts on startup).
    return registerAndPersistWorkspace(rootPath, result.bookmarks?.[0]);
  });

  ipcMain.handle('workspaces:register', async (_e, info: ElectronWorkspaceInfo) => {
    const settings = await readSettings();
    const persisted = settings.workspaces.find((w) => w.id === info.id);
    if (
      !persisted ||
      normaliseTrustPath(persisted.rootPath) !== normaliseTrustPath(info.rootPath)
    ) {
      throw new Error(
        'Workspace root is not trusted. Open the folder with the native picker first.',
      );
    }

    roots.register(persisted.id, persisted.rootPath);

    if (persisted.name !== info.name) {
      await updateSettings((s) => {
        const existing = s.workspaces.find((w) => w.id === info.id);
        if (
          existing &&
          normaliseTrustPath(existing.rootPath) === normaliseTrustPath(info.rootPath)
        ) {
          existing.name = info.name;
        }
        return s;
      });
    }
  });

  ipcMain.handle('workspaces:unregister', async (_e, id: string) => {
    roots.unregister(id);
    await updateSettings((s) => {
      s.workspaces = s.workspaces.filter((w) => w.id !== id);
      return s;
    });
  });
}
