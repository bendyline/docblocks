import { wikiLinkPath, type WikiLinkSuggestion } from '@bendyline/squisq/markdown';
import { FsError } from './fs-error.js';
import {
  parseWorkspacePath,
  workspacePathDirname,
  workspacePathJoin,
  type WorkspacePath,
} from './workspace-path.js';
import { getFileSystemProviderV2, type FileSystemProvider } from './types.js';

/** Immediate article/folder suggestions from an already bounded listing. */
export function suggestWikiArticles(
  files: readonly { path: string }[],
  directories: readonly string[],
  documentPath: string,
  query: string,
  extension: '.md' | '.html' = '.md',
  explicitExtensions = false,
): WikiLinkSuggestion[] {
  if (query.length > 2048 || (query && !wikiLinkPath(`${query.trimEnd()}x`))) return [];
  const source = parseWorkspacePath(documentPath);
  const parent = workspacePathDirname(source);
  const rootPrefix = parent ? `${parent}/` : '';
  const slash = query.lastIndexOf('/');
  const prefix = query.slice(0, slash + 1);
  const needle = query.slice(slash + 1).toLowerCase();
  const candidates: WikiLinkSuggestion[] = [];
  const relative = (path: string) => {
    if (!path.startsWith(rootPrefix)) return null;
    const target = path.slice(rootPrefix.length);
    if (!target.startsWith(prefix)) return null;
    const name = target.slice(prefix.length);
    return name && !name.includes('/') && name.toLowerCase().includes(needle) ? target : null;
  };
  for (const directory of directories) {
    const target = relative(directory);
    if (target && target.length < 2048 && wikiLinkPath(target))
      candidates.push({
        target: `${target}/`,
        label: `${target.slice(prefix.length)}/`,
        kind: 'folder',
      });
  }
  const articlePaths = new Set(files.map((file) => file.path));
  for (const file of files) {
    if (file.path === source || !/\.(?:md|html?)$/i.test(file.path)) continue;
    const target = relative(file.path);
    if (!target || !wikiLinkPath(target)) continue;
    const stem = file.path.replace(/\.(?:md|html?)$/i, '');
    const preferred = [`${stem}${extension}`, `${stem}.md`, `${stem}.html`, `${stem}.htm`].find(
      (path) => articlePaths.has(path),
    );
    // Keep extensions when needed to disambiguate two articles with the same stem.
    const insertion =
      !explicitExtensions && file.path === preferred
        ? target.replace(/\.(?:md|html?)$/i, '')
        : target;
    candidates.push({ target: insertion, label: insertion.slice(prefix.length), kind: 'article' });
  }
  return candidates
    .sort(
      (a, b) =>
        Number(b.kind === 'folder') - Number(a.kind === 'folder') ||
        Number(b.label.toLowerCase().startsWith(needle)) -
          Number(a.label.toLowerCase().startsWith(needle)) ||
        a.label.localeCompare(b.label) ||
        a.target.localeCompare(b.target),
    )
    .slice(0, 20);
}

/** Resolve a literal wiki name beside its source, never relative to the media sidecar. */
export function resolveWikiArticlePath(
  documentPath: string,
  target: string,
  extension: '.md' | '.html' = '.md',
): WorkspacePath {
  const relative = wikiLinkPath(target, extension);
  if (!relative) throw new FsError('invalid-path', 'Invalid wiki article name.');
  return workspacePathJoin(workspacePathDirname(parseWorkspacePath(documentPath)), relative);
}

/** Prefer the workspace's article format, then reuse an existing alternate.
 * Explicit extensions always address exactly that file. No recursive scan. */
export async function findWikiArticle(
  provider: FileSystemProvider,
  documentPath: string,
  target: string,
  extension: '.md' | '.html' = '.md',
): Promise<{ path: WorkspacePath; relativePath: string; exists: boolean }> {
  const preferred = resolveWikiArticlePath(documentPath, target, extension);
  const candidates = /\.(?:md|html?)$/i.test(target)
    ? [target]
    : [...new Set([`${target}${extension}`, `${target}.md`, `${target}.html`, `${target}.htm`])];
  for (const relativePath of candidates) {
    const path = resolveWikiArticlePath(documentPath, relativePath, extension);
    if (await wikiArticleExists(provider, path)) return { path, relativePath, exists: true };
  }
  return { path: preferred, relativePath: wikiLinkPath(target, extension)!, exists: false };
}

export async function wikiArticleExists(
  provider: FileSystemProvider,
  path: WorkspacePath,
): Promise<boolean> {
  const v2 = getFileSystemProviderV2(provider);
  if (!v2) return (await provider.stat(path)) !== null;
  const entry = await v2.stat(path);
  if (entry && entry.kind !== 'file')
    throw new FsError('type-mismatch', 'The article path is a folder.');
  return entry !== null;
}

/** Create only after the current DocumentSession has flushed. A race winner
 * is opened as-is; permission and IO errors must not become "missing". */
export async function ensureWikiArticle(
  provider: FileSystemProvider,
  path: WorkspacePath,
): Promise<boolean> {
  if (await wikiArticleExists(provider, path)) return false;
  const v2 = getFileSystemProviderV2(provider);
  if (!v2) throw new FsError('not-supported', 'This workspace cannot create articles safely.');
  try {
    await v2.writeFile(path, new Uint8Array(), {
      mode: 'create',
      expectedVersion: null,
      createParents: true,
    });
    return true;
  } catch (error: unknown) {
    if (
      error instanceof FsError &&
      (error.code === 'already-exists' || error.code === 'conflict')
    ) {
      if (await wikiArticleExists(provider, path)) return false;
    }
    throw error;
  }
}
