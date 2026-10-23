/**
 * Plain-language text for a folder listing that failed.
 *
 * A filesystem error's own message is written for logs and is often a raw
 * browser or OS string ("Failed to execute 'transaction' on 'IDBDatabase':
 * The database connection is closing.", "UNKNOWN: unknown error, read"). The
 * explorer speaks from the stable error code instead; the issue keeps the
 * original message for diagnostics.
 */

import { tryParseWorkspacePath } from '@bendyline/docblocks/filesystem';
import type { FileTreeReadIssue } from './useFileTree.js';

export function readIssueText(issue: FileTreeReadIssue): string {
  const failingPath = tryParseWorkspacePath(issue.path);
  if (failingPath && failingPath !== issue.directoryPath) {
    return fileIssueText(issue, failingPath);
  }
  return issue.directoryPath === '' ? workspaceIssueText(issue) : folderIssueText(issue);
}

/** The listing failed on one entry inside the directory, not the directory itself. */
function fileIssueText(issue: FileTreeReadIssue, path: string): string {
  switch (issue.code) {
    case 'not-found':
      return `${path} can't be found.`;
    case 'permission-denied':
      return `DocBlocks doesn't have permission to open ${path}.`;
    default:
      return `${path} couldn't be read.`;
  }
}

function workspaceIssueText(issue: FileTreeReadIssue): string {
  switch (issue.code) {
    case 'not-found':
      return "This workspace's folder can't be found. It may have been moved or deleted.";
    case 'permission-denied':
      return "DocBlocks doesn't have permission to open this workspace.";
    case 'quota-exceeded':
      return 'Your device is out of storage space.';
    case 'corrupt':
      return "Some of this workspace's saved data couldn't be read.";
    default:
      return "Your documents couldn't be loaded.";
  }
}

function folderIssueText(issue: FileTreeReadIssue): string {
  switch (issue.code) {
    case 'not-found':
      return "This folder can't be found.";
    case 'permission-denied':
      return "DocBlocks doesn't have permission to open this folder.";
    case 'quota-exceeded':
      return 'Your device is out of storage space.';
    case 'corrupt':
      return "Some of this folder's saved data couldn't be read.";
    default:
      return "This folder couldn't be opened.";
  }
}
