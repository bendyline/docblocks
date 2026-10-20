import {
  ensureWikiArticle,
  wikiArticleExists,
  FsError,
  getFileSystemProviderV2,
  type FileSystemProvider,
  type WorkspacePath,
} from '@bendyline/docblocks/filesystem';
import { newFileHtmlOutput, type NewFileFormat } from '../FileExplorer/new-file-formats.js';
import { createNewOutsideInDocument, type OutsideInRenderOptions } from './outside-in.js';

export function wikiArticleExtension(format: NewFileFormat): '.md' | '.html' {
  return newFileHtmlOutput(format) ? '.html' : '.md';
}

/** Called inside the session transition, after the source has flushed. */
export async function ensureShellWikiArticle(
  provider: FileSystemProvider,
  path: WorkspacePath,
  format: NewFileFormat,
  render?: OutsideInRenderOptions,
): Promise<boolean> {
  if (!/\.html?$/i.test(path)) return ensureWikiArticle(provider, path);
  if (await wikiArticleExists(provider, path)) return false;
  if (!getFileSystemProviderV2(provider)) {
    throw new FsError('not-supported', 'This workspace cannot create articles safely.');
  }
  try {
    await createNewOutsideInDocument(provider, path, newFileHtmlOutput(format), render);
    return true;
  } catch (error: unknown) {
    if (
      error instanceof FsError &&
      (error.code === 'already-exists' || error.code === 'conflict') &&
      (await wikiArticleExists(provider, path))
    )
      return false;
    throw error;
  }
}
