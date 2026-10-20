import * as vscode from 'vscode';
import {
  resolveWikiArticlePath,
  suggestWikiArticles,
  workspacePathDirname,
  isDiscoverableWorkspaceEntry,
} from '@bendyline/docblocks/filesystem';

/** Check each path component, including the leaf, before either opening or
 * creating. No symlink/junction is an article or a directory authority. */
async function checkPath(
  root: vscode.Uri,
  path: string,
  leafKind = vscode.FileType.File,
): Promise<boolean> {
  const parts = path.split('/').filter(Boolean);
  for (let depth = 0; depth <= parts.length; depth++) {
    const uri = depth ? vscode.Uri.joinPath(root, ...parts.slice(0, depth)) : root;
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch (error: unknown) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return false;
      throw error;
    }
    if ((stat.type & vscode.FileType.SymbolicLink) !== 0)
      throw new Error('Wiki links cannot follow symbolic links.');
    const expected = depth === parts.length ? leafKind : vscode.FileType.Directory;
    if ((stat.type & expected) === 0) throw new Error('The article path has the wrong file type.');
  }
  return true;
}

/** Only list the requested folder: no new workspace-wide filesystem walker. */
export async function suggestWikiArticleTargets(source: vscode.Uri, query: string) {
  const folder = vscode.workspace.getWorkspaceFolder(source);
  if (!folder || query.length > 2048) return [];
  const documentPath = vscode.workspace.asRelativePath(source, false);
  const prefix = query.slice(0, query.lastIndexOf('/') + 1);
  const directory = workspacePathDirname(
    await resolveWikiArticlePath(documentPath, `${prefix}wiki-lookup`),
  );
  if (!(await checkPath(folder.uri, directory, vscode.FileType.Directory))) return [];
  const entries = await vscode.workspace.fs.readDirectory(
    vscode.Uri.joinPath(folder.uri, ...directory.split('/').filter(Boolean)),
  );
  const files: { path: string }[] = [];
  const directories: string[] = [];
  for (const [name, type] of entries.slice(0, 5000)) {
    if ((type & vscode.FileType.SymbolicLink) !== 0) continue;
    const kind = (type & vscode.FileType.Directory) !== 0 ? 'directory' : 'file';
    if (!isDiscoverableWorkspaceEntry(name, kind)) continue;
    const path = directory ? `${directory}/${name}` : name;
    if (kind === 'directory') directories.push(path);
    else files.push({ path });
  }
  return suggestWikiArticles(files, directories, documentPath, query, '.md', true);
}

export async function accessWikiArticle(
  source: vscode.Uri,
  target: string,
  action: 'exists' | 'open' | 'create',
  beforeOpen: () => Promise<void>,
): Promise<boolean> {
  const folder = vscode.workspace.getWorkspaceFolder(source);
  if (!folder) throw new Error('Open a workspace folder to use wiki links.');
  const path = await resolveWikiArticlePath(vscode.workspace.asRelativePath(source, false), target);
  let exists = await checkPath(folder.uri, path);
  if (action === 'exists') return exists;
  await beforeOpen();
  exists = await checkPath(folder.uri, path);
  const uri = vscode.Uri.joinPath(folder.uri, ...path.split('/'));
  if (!exists && action === 'create') {
    if (/\.html?$/i.test(path)) {
      throw new Error(
        'Create HTML articles in a DocBlocks workspace with Web page as its default type.',
      );
    }
    if (
      !vscode.workspace.isTrusted ||
      vscode.workspace.fs.isWritableFileSystem(uri.scheme) === false
    ) {
      throw new Error('This workspace does not allow article creation.');
    }
    // The workspace edit's no-overwrite create is also safe if another editor
    // creates the article after our lookup. Never write an initial body over it.
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { overwrite: false, ignoreIfExists: true });
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('Could not create the article.');
    exists = await checkPath(folder.uri, path);
  } else {
    exists = await checkPath(folder.uri, path);
  }
  if (!exists) throw new Error('The linked article was not found.');
  if (/\.html?$/i.test(path)) await vscode.commands.executeCommand('vscode.open', uri);
  else
    await vscode.commands.executeCommand('vscode.openWith', uri, 'docblocks.markdownEditor', {
      preview: false,
    });
  return true;
}
