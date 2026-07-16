import type { DocumentSessionMessageStatus } from '@bendyline/docblocks/vscode';

/** True only while an enabled autosave is waiting for its idle-delay timer. */
export function isAutoSavePending(
  autoSaveEnabled: boolean,
  status: DocumentSessionMessageStatus,
): boolean {
  return autoSaveEnabled && status === 'dirty';
}
