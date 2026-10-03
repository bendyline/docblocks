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
import fs from 'node:fs/promises';
import path from 'node:path';
import { HOST_WIRE_LIMITS, isBoundedBytePayload, isBoundedString } from '@bendyline/docblocks/host';

import {
  consumeExportPickerApproval,
  mintExportGrant,
  resolveExportGrant,
  revokeExportOwner,
  type ResolvedExportTarget,
} from './export-grants.js';
import {
  confirmExportReplacement,
  readExportTargetIdentity,
  type ExportReplacementDetails,
} from './export-overwrite.js';
import { exportSaveErrorMessage } from './export-save-error.js';
import { ExportTransfers } from './export-transfers.js';
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
const uploads = new ExportTransfers();

function ownerFor(event: IpcMainInvokeEvent): WebContents {
  const owner = assertTrustedIpcSender(event);
  if (!boundOwners.has(owner)) {
    boundOwners.add(owner);
    const ownerId = owner.id;
    bindOwnerGrantRevocation(owner, () => {
      revokeExportOwner(ownerId);
      void uploads.revokeOwner(ownerId).catch((error: unknown) => {
        process.stderr.write(`Export upload revocation failed: ${String(error)}\n`);
      });
    });
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

function requireGrant(value: unknown): string {
  const grantId = requireOptionalGrant(value);
  if (!grantId) throw new Error('Invalid export target grant');
  return grantId;
}

function requireTransferId(value: unknown): string {
  if (!isBoundedString(value, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
    throw new Error('Invalid export upload identifier');
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

/** Re-verify a grant for this document and file type, and reopen sandboxed access. */
async function resolveGrantedTarget(
  ownerId: number,
  documentKey: string,
  filename: string,
  grantId: string,
): Promise<ResolvedExportTarget> {
  const target = await resolveExportGrant(ownerId, documentKey, grantId);
  if (getExportExtension(filename) !== getExportExtension(target.absolutePath)) {
    throw new Error('Export target grant does not match the requested file type');
  }
  if (target.bookmark) beginAccess({ path: target.absolutePath, bookmark: target.bookmark });
  return target;
}

/** Rethrow expected native write failures (locked, full, read-only) as actionable text. */
async function withExportSaveErrors<T>(targetPath: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    const message = exportSaveErrorMessage(error, targetPath);
    if (message) throw new Error(message);
    throw error;
  }
}

/** Describe an upload's write failures by the file it is headed for, when known. */
function withUploadErrors<T>(ownerId: number, transferId: string, work: () => Promise<T>) {
  const targetPath = uploads.targetPath(ownerId, transferId);
  return targetPath ? withExportSaveErrors(targetPath, work) : work();
}

/**
 * Publish to a granted target: honor the picker's one-shot replacement
 * approval, confirm any other replacement, then `write` under the target lock.
 */
async function commitExport(
  event: IpcMainInvokeEvent,
  ownerId: number,
  documentKey: string,
  filename: string,
  grantId: string,
  write: (absolutePath: string) => Promise<void>,
): Promise<{ grantId: string; displayPath: string } | null> {
  const target = await resolveGrantedTarget(ownerId, documentKey, filename, grantId);
  const pickerApprovedIdentity = consumeExportPickerApproval(ownerId, grantId);

  const saved = await withExportSaveErrors(target.absolutePath, () =>
    withFileMutationLocks([target.absolutePath], async () => {
      const confirmed = await confirmExportReplacement(
        target.absolutePath,
        pickerApprovedIdentity,
        (details) => showReplacementConfirmation(event, details),
      );
      if (!confirmed) return false;
      await write(target.absolutePath);
      return true;
    }),
  );
  if (!saved) return null;
  await rememberTarget(documentKey, target.absolutePath, target.bookmark);
  return { grantId, displayPath: target.absolutePath };
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

      return commitExport(event, owner.id, documentKey, filename, grant.grantId, (absolutePath) =>
        atomicWriteBinary(absolutePath, dataValue),
      );
    },
  );

  // Exports too large for one message (long videos) arrive in bounded chunks.
  // The grant is required up front so no bytes move before authority exists.
  ipcMain.handle('exports:beginSave', async (event, ...args: unknown[]): Promise<string> => {
    const owner = ownerFor(event);
    assertIpcArgumentCount(args, 4);
    const [documentValue, fileValue, grantValue, sizeValue] = args;
    const documentKey = storageKey(documentValue);
    const filename = requireFilename(fileValue);
    const grantId = requireGrant(grantValue);
    const target = await resolveGrantedTarget(owner.id, documentKey, filename, grantId);
    return withExportSaveErrors(target.absolutePath, () =>
      uploads.begin(
        owner.id,
        { documentKey, filename, grantId, absolutePath: target.absolutePath },
        sizeValue,
      ),
    );
  });

  ipcMain.handle('exports:writeChunk', async (event, ...args: unknown[]): Promise<void> => {
    const owner = ownerFor(event);
    assertIpcArgumentCount(args, 3);
    const [transferValue, offsetValue, dataValue] = args;
    const transferId = requireTransferId(transferValue);
    await withUploadErrors(owner.id, transferId, () =>
      uploads.writeChunk(owner.id, transferId, offsetValue, dataValue),
    );
  });

  ipcMain.handle(
    'exports:finishSave',
    async (event, ...args: unknown[]): Promise<{ grantId: string; displayPath: string } | null> => {
      const owner = ownerFor(event);
      assertIpcArgumentCount(args, 1);
      const transferId = requireTransferId(args[0]);
      return withUploadErrors(owner.id, transferId, () =>
        uploads.finish(owner.id, transferId, (upload) =>
          // A grant's path never changes and the spool sits beside it, so this
          // rename is the same atomic same-directory publish as atomicWriteBinary.
          commitExport(event, owner.id, upload.documentKey, upload.filename, upload.grantId, (to) =>
            fs.rename(upload.temporaryPath, to),
          ),
        ),
      );
    },
  );

  ipcMain.handle('exports:closeTransfer', async (event, ...args: unknown[]): Promise<void> => {
    const owner = ownerFor(event);
    assertIpcArgumentCount(args, 1);
    await uploads.close(owner.id, requireTransferId(args[0]));
  });
}
