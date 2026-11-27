/**
 * Which documents are Ask's saved chats: everything in a chats folder. Kept
 * apart from `ask-chats.ts` (saving and reading them), which loads with Ask,
 * because the shell lists chats and leaves them out of AI passages up front.
 */

import { workspacePathContains, type WorkspacePath } from '@bendyline/docblocks/filesystem';
import { kindFoldersOf, titleOfFileName, type KindFolder } from '@bendyline/docblocks/folders';

/** A saved chat, as Ask lists it. */
export interface ChatListing {
  readonly path: WorkspacePath;
  readonly title: string;
  readonly lastModified: string;
}

const MARKDOWN = /\.(?:md|markdown|mdown)$/iu;

/** The Markdown documents in the workspace's chats folders, most recently changed first. */
export function listChats(
  documents: readonly { readonly path: WorkspacePath; readonly lastModified: string }[],
  kindFolders: readonly KindFolder[],
): ChatListing[] {
  const folders = kindFoldersOf(kindFolders, 'chats');
  if (folders.length === 0) return [];
  return documents
    .filter(
      (document) =>
        MARKDOWN.test(document.path) &&
        folders.some((folder) => workspacePathContains(folder.path, document.path, false)),
    )
    .map((document) => ({
      path: document.path,
      title: titleOfFileName(document.path),
      lastModified: document.lastModified,
    }))
    .sort(
      (left, right) =>
        right.lastModified.localeCompare(left.lastModified) ||
        left.title.localeCompare(right.title),
    );
}

/** Every document in a chats folder, for leaving out of the passages AI is given. */
export function chatDocumentPaths(
  documents: readonly { readonly path: WorkspacePath }[],
  kindFolders: readonly KindFolder[],
): Set<string> {
  const folders = kindFoldersOf(kindFolders, 'chats');
  if (folders.length === 0) return new Set();
  return new Set(
    documents
      .filter((document) =>
        folders.some((folder) => workspacePathContains(folder.path, document.path, false)),
      )
      .map((document) => document.path),
  );
}
