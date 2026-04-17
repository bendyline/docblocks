/**
 * IPC handlers for workspace management — default folder, picker, register.
 */

import { ipcMain, dialog, BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ElectronWorkspaceInfo } from '@bendyline/docblocks/host';

import { getWorkspaceRoots } from './workspace-roots.js';
import { updateSettings, readSettings } from './settings.js';
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

async function ensureFolder(absPath: string): Promise<void> {
  await fs.mkdir(absPath, { recursive: true });
}

export function registerWorkspaceIpc(): void {
  const roots = getWorkspaceRoots();

  ipcMain.handle('workspaces:getDefault', async (event): Promise<ElectronWorkspaceInfo> => {
    const settings = await readSettings();

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

    // First launch — consider iCloud on macOS and give the user one prompt.
    let chosenRoot = suggestedDefaultRoot();
    if (
      process.platform === 'darwin' &&
      isMacOSDocumentsICloudManaged() &&
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
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const rootPath = result.filePaths[0];
    const id = deriveWorkspaceId(rootPath);
    const name = path.basename(rootPath) || 'Folder';
    roots.register(id, rootPath);

    await updateSettings((s) => {
      if (!s.workspaces.some((w) => w.id === id)) {
        s.workspaces.push({ id, name, rootPath });
      }
      return s;
    });

    return { id, name, rootPath };
  });

  ipcMain.handle('workspaces:register', async (_e, info: ElectronWorkspaceInfo) => {
    roots.register(info.id, info.rootPath);
    await updateSettings((s) => {
      const idx = s.workspaces.findIndex((w) => w.id === info.id);
      if (idx >= 0) {
        s.workspaces[idx] = info;
      } else {
        s.workspaces.push(info);
      }
      return s;
    });
  });

  ipcMain.handle('workspaces:unregister', async (_e, id: string) => {
    roots.unregister(id);
    await updateSettings((s) => {
      s.workspaces = s.workspaces.filter((w) => w.id !== id);
      return s;
    });
  });
}
