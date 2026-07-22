/** Native save-target selection backed by exact owner-scoped grants. */

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type {
  IpcMainInvokeEvent,
  MessageBoxOptions,
  SaveDialogOptions,
  SaveDialogReturnValue,
  WebContents,
} from 'electron';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { HOST_WIRE_LIMITS, isBoundedBytePayload, isBoundedString } from '@bendyline/docblocks/host';

import {
  consumeExportPickerApproval,
  mintExportGrant,
  resolveExportGrant,
  revokeExportOwner,
} from './export-grants.js';
import {
  confirmExportReplacement,
  readExportTargetIdentity,
  type ExportReplacementDetails,
} from './export-overwrite.js';
import { exportSaveErrorMessage } from './export-save-error.js';
import {
  findExportTargetAccess,
  getExportExtension,
  resolveExportTarget,
  sanitizeExportFilename,
} from './export-targets.js';
import { atomicWriteBinary, withFileMutationLocks } from './file-commit.js';
import { assertIpcArgumentCount, assertTrustedIpcSender } from './ipc-authority.js';
import { bindOwnerGrantRevocation } from './owner-revocation.js';
import { isSandboxed, startAccessingBookmark } from './security-scoped.js';
import {
  readSettings,
  updateSettings,
  type PersistedExportTarget,
  type PersistedExportTargetAccess,
} from './settings.js';

const boundOwners = new WeakSet<WebContents>();

function ownerFor(event: IpcMainInvokeEvent): WebContents {
  const owner = assertTrustedIpcSender(event);
  if (!boundOwners.has(owner)) {
    boundOwners.add(owner);
    const ownerId = owner.id;
    bindOwnerGrantRevocation(owner, () => revokeExportOwner(ownerId));
  }
  return owner;
}

function storageKey(documentValue: unknown): string {
  if (!isBoundedString(documentValue, HOST_WIRE_LIMITS.pathCharacters, 1)) {
    throw new Error('Invalid export document identifier');
  }
  const documentId = documentValue.trim();
  if (!documentId) throw new Error('Invalid export document identifier');
  return createHash('sha256').update(documentId).digest('hex');
}

function requireFilename(value: unknown): string {
  if (!isBoundedString(value, HOST_WIRE_LIMITS.labelCharacters, 1)) {
    throw new Error('Invalid export filename');
  }
  return sanitizeExportFilename(value);
}

function requireOptionalGrant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (!isBoundedString(value, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
    throw new Error('Invalid export target grant');
  }
  return value;
}

async function readStoredTarget(documentKey: string): Promise<PersistedExportTarget | undefined> {
  const settings = await readSettings();
  return settings.exportTargets?.[documentKey];
}

async function rememberTarget(
  documentKey: string,
  targetPath: string,
  bookmark?: string,
): Promise<void> {
  const access: PersistedExportTargetAccess = bookmark
    ? { path: path.resolve(targetPath), bookmark, confirmedByPicker: true }
    : { path: path.resolve(targetPath), confirmedByPicker: true };
  const extension = getExportExtension(access.path);

  await updateSettings((settings) => {
    const exportTargets = { ...(settings.exportTargets ?? {}) };
    const previous = exportTargets[documentKey] ?? {};
    const byExtension = { ...(previous.byExtension ?? {}) };
    if (extension) byExtension[extension] = access;
    exportTargets[documentKey] = { last: access, byExtension };
    return { ...settings, exportTargets };
  });
}

function saveDialogOptions(filename: string, defaultPath: string): SaveDialogOptions {
  const extension = getExportExtension(filename);
  return {
    title: 'Export Document',
    defaultPath,
    filters: extension ? [{ name: extensionLabel(extension), extensions: [extension] }] : undefined,
    properties: ['showOverwriteConfirmation'],
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
    case 'epub':
      return 'EPUB e-book';
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

async function mintResolvedTarget(
  ownerId: number,
  documentKey: string,
  filename: string,
): Promise<{ grantId: string | null; displayPath: string }> {
  const stored = await readStoredTarget(documentKey);
  const targetPath = resolveExportTarget(app.getPath('downloads'), stored, filename);
  const access = findExportTargetAccess(stored, targetPath);
  if (!access) return { grantId: null, displayPath: targetPath };
  beginAccess(access);
  return mintExportGrant(ownerId, documentKey, targetPath, access?.bookmark);
}

async function pickTarget(
  event: IpcMainInvokeEvent,
  ownerId: number,
  documentKey: string,
  filename: string,
  currentGrantId: string | null,
): Promise<{ grantId: string; displayPath: string } | null> {
  let defaultPath = resolveExportTarget(
    app.getPath('downloads'),
    await readStoredTarget(documentKey),
    filename,
  );
  if (currentGrantId) {
    defaultPath = (await resolveExportGrant(ownerId, documentKey, currentGrantId)).absolutePath;
  }

  const result = await showSaveDialog(event, filename, defaultPath);
  if (result.canceled || !result.filePath) return null;

  const selectedPath = ensureExtension(path.resolve(result.filePath), filename);
  const selectedAccess = result.bookmark
    ? { path: selectedPath, bookmark: result.bookmark, confirmedByPicker: true as const }
    : null;
  beginAccess(selectedAccess);
  const pickerApprovedIdentity = await readExportTargetIdentity(selectedPath);
  const grant = await mintExportGrant(
    ownerId,
    documentKey,
    selectedPath,
    result.bookmark,
    pickerApprovedIdentity ?? undefined,
  );
  await rememberTarget(documentKey, grant.displayPath, result.bookmark);
  return grant;
}

async function showReplacementConfirmation(
  event: IpcMainInvokeEvent,
  details: ExportReplacementDetails,
): Promise<boolean> {
  const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const options: MessageBoxOptions = {
    type: 'warning',
    title: 'Replace existing export?',
    message: `"${details.filename}" already exists.`,
    detail: `Replace the existing file at ${details.displayPath}?`,
    buttons: ['Replace', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const result = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options);
  return result.response === 0;
}

export function registerExportIpc(): void {
  ipcMain.handle('exports:resolveTarget', async (event, ...args: unknown[]) => {
    const owner = ownerFor(event);
    assertIpcArgumentCount(args, 2);
    const [documentValue, fileValue] = args;
    return mintResolvedTarget(owner.id, storageKey(documentValue), requireFilename(fileValue));
  });

  ipcMain.handle(
    'exports:pickTarget',
    async (event, ...args: unknown[]): Promise<{ grantId: string; displayPath: string } | null> => {
      const owner = ownerFor(event);
      assertIpcArgumentCount(args, 3);
      const [documentValue, fileValue, grantValue] = args;
      return pickTarget(
        event,
        owner.id,
        storageKey(documentValue),
        requireFilename(fileValue),
        requireOptionalGrant(grantValue),
      );
    },
  );

  ipcMain.handle(
    'exports:save',
    async (event, ...args: unknown[]): Promise<{ grantId: string; displayPath: string } | null> => {
      const owner = ownerFor(event);
      assertIpcArgumentCount(args, 4);
      const [documentValue, fileValue, grantValue, dataValue] = args;
      const documentKey = storageKey(documentValue);
      const filename = requireFilename(fileValue);
      const grantId = requireOptionalGrant(grantValue);
      if (!isBoundedBytePayload(dataValue)) throw new Error('Export payload exceeds host limits');

      const grant = grantId
        ? { grantId, displayPath: '' }
        : await pickTarget(event, owner.id, documentKey, filename, null);
      if (!grant) return null;

      const target = await resolveExportGrant(owner.id, documentKey, grant.grantId);
      const requestedExtension = getExportExtension(filename);
      const targetExtension = getExportExtension(target.absolutePath);
      if (requestedExtension !== targetExtension) {
        throw new Error('Export target grant does not match the requested file type');
      }
      const pickerApprovedIdentity = consumeExportPickerApproval(owner.id, grant.grantId);

      if (target.bookmark) beginAccess({ path: target.absolutePath, bookmark: target.bookmark });
      let saved = false;
      try {
        saved = await withFileMutationLocks([target.absolutePath], async () => {
          const confirmed = await confirmExportReplacement(
            target.absolutePath,
            pickerApprovedIdentity,
            (details) => showReplacementConfirmation(event, details),
          );
          if (!confirmed) return false;
          await atomicWriteBinary(target.absolutePath, dataValue);
          return true;
        });
      } catch (error: unknown) {
        const message = exportSaveErrorMessage(error, target.absolutePath);
        if (message) throw new Error(message);
        throw error;
      }
      if (!saved) return null;
      await rememberTarget(documentKey, target.absolutePath, target.bookmark);
      return { grantId: grant.grantId, displayPath: target.absolutePath };
    },
  );
}
