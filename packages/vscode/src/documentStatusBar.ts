import type { DocumentSessionStatus } from '@bendyline/docblocks/document';
import type { DocumentConflictDetailsMessage } from '@bendyline/docblocks/vscode';

export type DocumentStatusBarAction = 'save' | 'resolve-conflict' | null;
export type DocumentStatusBarSeverity = 'normal' | 'warning' | 'error';

export interface DocumentStatusBarPresentation {
  text: string;
  tooltip: string;
  accessibilityLabel: string;
  action: DocumentStatusBarAction;
  severity: DocumentStatusBarSeverity;
}

/**
 * Translate document persistence state into native VS Code status-bar copy.
 * Keep this separate from the webview so save truth stays host-authoritative.
 */
export function getDocumentStatusBarPresentation(
  status: DocumentSessionStatus,
  fileName: string,
  errorMessage: string | null,
): DocumentStatusBarPresentation | null {
  switch (status) {
    case 'idle':
    case 'closed':
      return null;
    case 'saved':
      return {
        text: '$(check) DocBlocks: Saved',
        tooltip: `${fileName} is saved.`,
        accessibilityLabel: `DocBlocks: ${fileName} is saved`,
        action: null,
        severity: 'normal',
      };
    case 'dirty':
      return {
        text: '$(edit) DocBlocks: Unsaved changes',
        tooltip: `${fileName} has unsaved changes. Select to save.`,
        accessibilityLabel: `DocBlocks: ${fileName} has unsaved changes. Select to save`,
        action: 'save',
        severity: 'normal',
      };
    case 'saving':
      return {
        text: '$(sync~spin) DocBlocks: Saving…',
        tooltip: `Saving ${fileName}…`,
        accessibilityLabel: `DocBlocks: saving ${fileName}`,
        action: null,
        severity: 'normal',
      };
    case 'error': {
      const detail = errorMessage ? `: ${errorMessage.replace(/[.!?]+$/, '')}` : '';
      return {
        text: '$(error) DocBlocks: Save failed',
        tooltip: `${fileName} could not be saved${detail}. Select to retry.`,
        accessibilityLabel: `DocBlocks: ${fileName} could not be saved. Select to retry`,
        action: 'save',
        severity: 'error',
      };
    }
    case 'conflict':
      return {
        text: '$(warning) DocBlocks: Resolve conflict',
        tooltip: `${fileName}'s VS Code buffer changed outside this DocBlocks editor while local changes were pending. Select to resolve.`,
        accessibilityLabel: `DocBlocks: ${fileName} has conflicting changes. Select to resolve`,
        action: 'resolve-conflict',
        severity: 'warning',
      };
  }
}

export function formatConflictResolutionDetail(
  details: DocumentConflictDetailsMessage | null,
): string | undefined {
  if (!details) return undefined;

  const localTime =
    details.localEditedAt === null ? 'unavailable' : formatTime(details.localEditedAt);
  const externalTime =
    details.externalObservedAt === null ? 'unavailable' : formatTime(details.externalObservedAt);
  const externalSize =
    details.externalBytes === null ? 'deleted' : `${formatBytes(details.externalBytes)} UTF-8`;
  const externalSaveState =
    details.externalIsDirty === true
      ? 'unsaved in VS Code'
      : details.externalIsDirty === false
        ? 'saved in VS Code'
        : 'save state unavailable';

  return [
    `Your draft: ${formatBytes(details.localBytes)} UTF-8, last edited ${localTime}, based on VS Code version ${details.localBaseDocumentVersion}.`,
    `Current version: ${externalSize}, observed ${externalTime}, VS Code version ${details.externalDocumentVersion}, ${externalSaveState}.`,
  ].join('\n\n');
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function formatBytes(bytes: number): string {
  return `${new Intl.NumberFormat().format(bytes)} ${bytes === 1 ? 'byte' : 'bytes'}`;
}
