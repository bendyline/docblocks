/** Native save-target selection and export persistence for the desktop app. */

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, SaveDialogOptions, SaveDialogReturnValue } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  findExportTargetAccess,
  getExportExtension,
  isInExportDirectory,
  isInRememberedExportDirectory,
  resolveExportTarget,
  resolveRequestedExportTarget,
} from './export-targets.js';
import { isSandboxed, startAccessingBookmark } from './security-scoped.js';
import {
  readSettings,
  updateSettings,
  type PersistedExportTarget,
  type PersistedExportTargetAccess,
} from './settings.js';

function storageKey(documentId: string): string {
  const normalized = documentId.trim();
  if (!normalized || normalized.length > 4096 || normalized.includes('\0')) {
    throw new Error('Invalid export document identifier');
  }
  return createHash('sha256').update(normalized).digest('hex');
}

async function readStoredTarget(documentId: string): Promise<PersistedExportTarget | undefined> {
  const settings = await readSettings();
  return settings.exportTargets?.[storageKey(documentId)];
}

async function rememberTarget(
  documentId: string,
  targetPath: string,
  bookmark?: string,
): Promise<void> {
  const key = storageKey(documentId);
  const access: PersistedExportTargetAccess = bookmark
    ? { path: path.resolve(targetPath), bookmark }
    : { path: path.resolve(targetPath) };
  const extension = getExportExtension(access.path);

  await updateSettings((settings) => {
    const exportTargets = { ...(settings.exportTargets ?? {}) };
    const previous = exportTargets[key] ?? {};
    const byExtension = { ...(previous.byExtension ?? {}) };
    if (extension) byExtension[extension] = access;
    exportTargets[key] = { last: access, byExtension };
    return { ...settings, exportTargets };
  });
}

function saveDialogOptions(filename: string, defaultPath: string): SaveDialogOptions {
  const extension = getExportExtension(filename);
  return {
    title: 'Export Document',
    defaultPath,
    filters: extension ? [{ name: extensionLabel(extension), extensions: [extension] }] : undefined,
    securityScopedBookmarks: isSandboxed(),
  };
}

async function showSaveDialog(
  event: IpcMainInvokeEvent,
  filename: string,
  defaultPath: string,
): Promise<SaveDialogReturnValue> {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options = saveDialogOptions(filename, defaultPath);
  return owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options);
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

function ensureExtension(targetPath: string, filename: string): string {
  if (getExportExtension(targetPath)) return targetPath;
  const extension = getExportExtension(filename);
  return extension ? `${targetPath}.${extension}` : targetPath;
}

function beginAccess(access: PersistedExportTargetAccess | null): void {
  if (access?.bookmark) startAccessingBookmark(access.bookmark);
}

function toBuffer(data: ArrayBuffer | Uint8Array): Buffer {
  return data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(new Uint8Array(data));
}

export function registerExportIpc(): void {
  ipcMain.handle(
    'exports:resolveTarget',
    async (_event, documentId: string, filename: string): Promise<string> => {
      const stored = await readStoredTarget(documentId);
      return resolveExportTarget(app.getPath('downloads'), stored, filename);
    },
  );

  ipcMain.handle(
    'exports:pickTarget',
    async (
      event,
      documentId: string,
      filename: string,
      currentPath?: string | null,
    ): Promise<string | null> => {
      const stored = await readStoredTarget(documentId);
      const downloadsDirectory = app.getPath('downloads');
      const fallback = resolveExportTarget(downloadsDirectory, stored, filename);
      const requested = ensureExtension(
        resolveRequestedExportTarget(fallback, currentPath ?? null),
        filename,
      );
      const result = await showSaveDialog(event, filename, requested);
      if (result.canceled || !result.filePath) return null;

      const targetPath = ensureExtension(path.resolve(result.filePath), filename);
      beginAccess(result.bookmark ? { path: targetPath, bookmark: result.bookmark } : null);
      await rememberTarget(documentId, targetPath, result.bookmark);
      return targetPath;
    },
  );

  ipcMain.handle(
    'exports:save',
    async (
      event,
      documentId: string,
      filename: string,
      targetPath: string | null,
      data: ArrayBuffer | Uint8Array,
    ): Promise<string | null> => {
      let stored = await readStoredTarget(documentId);
      const downloadsDirectory = app.getPath('downloads');
      const fallback = resolveExportTarget(downloadsDirectory, stored, filename);
      let resolvedTarget = ensureExtension(
        resolveRequestedExportTarget(fallback, targetPath),
        filename,
      );
      let bookmark: string | undefined;

      const exactAccess = findExportTargetAccess(stored, resolvedTarget);
      const canWriteToDownloads = isInExportDirectory(downloadsDirectory, resolvedTarget);
      const canWriteRememberedSibling =
        !isSandboxed() && isInRememberedExportDirectory(stored, resolvedTarget);

      if (exactAccess) {
        bookmark = exactAccess.bookmark;
        beginAccess(exactAccess);
      } else if (!canWriteToDownloads && !canWriteRememberedSibling) {
        const result = await showSaveDialog(event, filename, resolvedTarget);
        if (result.canceled || !result.filePath) return null;
        resolvedTarget = ensureExtension(path.resolve(result.filePath), filename);
        bookmark = result.bookmark;
        beginAccess(bookmark ? { path: resolvedTarget, bookmark } : null);
        await rememberTarget(documentId, resolvedTarget, bookmark);
        stored = await readStoredTarget(documentId);
      }

      await fs.writeFile(resolvedTarget, toBuffer(data));
      const remembered = findExportTargetAccess(stored, resolvedTarget);
      await rememberTarget(documentId, resolvedTarget, bookmark ?? remembered?.bookmark);
      return resolvedTarget;
    },
  );
}
