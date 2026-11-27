/**
 * Move a file from one workspace into a folder of another.
 *
 * Two workspaces share no rename, so the move is a copy and then a removal.
 * The file takes its companion folder (`notes_files/`: media and versions)
 * along, the way a move inside one workspace does. Nothing is replaced: the
 * file is numbered past a name already taken there (`Notes (2).md`), and a
 * Markdown document's references into its companion follow the new name.
 *
 * Either the whole file arrives or nothing changes. Until the original is
 * removed, a failure removes what was written; the original is removed only
 * at the version that was copied, so a change made to it meanwhile keeps it
 * where it was. Its companion's files go the same way, each only as copied,
 * so anything added to it meanwhile stays behind rather than being lost.
 */

import { numberedFileName } from '../folders/names.js';
import { companionPathFor } from './companion-path.js';
import { rewriteCompanionReferences } from './companion-references.js';
import { FsError } from './fs-error.js';
import { copyBytes } from './internal/bytes.js';
import { getFileSystemProviderV2, type FileSystemProvider } from './types.js';
import { isMarkdownFileName } from './workspace-entry-rules.js';
import type { FileSystemProviderV2, FileSystemVersion } from './v2.js';
import {
  parseWorkspacePath,
  workspacePathBasename,
  workspacePathJoin,
  type WorkspacePath,
} from './workspace-path.js';

interface CopiedFile {
  /** Relative to the companion folder. */
  readonly relative: string;
  readonly data: ArrayBuffer;
  readonly version: FileSystemVersion;
}

interface CompanionTree {
  readonly root: WorkspacePath;
  /** Relative to the companion folder, parents before their children. */
  readonly directories: readonly string[];
  readonly files: readonly CopiedFile[];
}

/** The most numbered names tried before giving up. */
const NAME_ATTEMPTS = 200;

async function readCompanionTree(
  storage: FileSystemProviderV2,
  root: WorkspacePath,
): Promise<CompanionTree> {
  const directories: string[] = [];
  const files: CopiedFile[] = [];
  const walk = async (folder: WorkspacePath, relative: string) => {
    for (const entry of await storage.readDirectory(folder)) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        directories.push(childRelative);
        await walk(entry.path, childRelative);
        continue;
      }
      const read = await storage.readFile(entry.path);
      // Gone since it was listed: there is nothing left of it to take along.
      if (read)
        files.push({ relative: childRelative, data: read.data, version: read.entry.version });
    }
  };
  await walk(root, '');
  return { root, directories, files };
}

/** Rewrite a Markdown document's companion references for its new name. */
async function renamedDocument(
  data: ArrayBuffer,
  from: WorkspacePath,
  to: WorkspacePath,
): Promise<ArrayBuffer> {
  if (workspacePathBasename(from) === workspacePathBasename(to)) return data;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return data;
  }
  const next = await rewriteCompanionReferences(text, from, to);
  if (next === text) return data;
  return copyBytes(new TextEncoder().encode(next));
}

/**
 * Move the file at `path` in `source` into `folder` (`''` for the top) of
 * `destination`, returning where it landed. Rejects, with nothing changed,
 * when the file is missing, changed while it was being copied, or could not
 * be written.
 */
export async function moveFileBetweenWorkspaces(
  source: FileSystemProvider,
  destination: FileSystemProvider,
  path: string,
  folder: string,
): Promise<WorkspacePath> {
  const from = getFileSystemProviderV2(source);
  const to = getFileSystemProviderV2(destination);
  if (!from || !to) throw new Error('Moving documents requires a current workspace provider.');

  const sourcePath = parseWorkspacePath(path);
  const folderPath = parseWorkspacePath(folder);
  const read = await from.readFile(sourcePath);
  if (!read) {
    throw new FsError('not-found', 'The file to move is not there.', {
      operation: 'read',
      path: sourcePath,
    });
  }

  const companionOf = companionPathFor(sourcePath);
  const sourceCompanion = companionOf ? parseWorkspacePath(companionOf(sourcePath)) : null;
  const companion =
    sourceCompanion && (await from.stat(sourceCompanion))?.kind === 'directory'
      ? await readCompanionTree(from, sourceCompanion)
      : null;

  // A name free for the file and, when it has one, for its companion too.
  let target: WorkspacePath | null = null;
  for (let attempt = 1; attempt <= NAME_ATTEMPTS && target === null; attempt += 1) {
    const candidate = workspacePathJoin(
      folderPath,
      numberedFileName(workspacePathBasename(sourcePath), attempt),
    );
    if ((await to.stat(candidate)) !== null) continue;
    if (companion && companionOf) {
      if ((await to.stat(parseWorkspacePath(companionOf(candidate)))) !== null) continue;
    }
    target = candidate;
  }
  if (target === null) throw new Error('Too many files there already have that name.');
  const targetCompanion = companion && companionOf ? parseWorkspacePath(companionOf(target)) : null;

  const data =
    companion && isMarkdownFileName(sourcePath)
      ? await renamedDocument(read.data, sourcePath, target)
      : read.data;

  const createdFiles: { readonly path: WorkspacePath; readonly version: FileSystemVersion }[] = [];
  const createdDirectories: WorkspacePath[] = [];
  const undo = async () => {
    for (const file of [...createdFiles].reverse()) {
      await to
        .remove(file.path, { missing: 'ignore', expectedVersion: file.version })
        .catch(() => undefined);
    }
    // Not recursive: anything put there meanwhile is not ours to remove.
    for (const directory of [...createdDirectories].reverse()) {
      await to.remove(directory, { missing: 'ignore' }).catch(() => undefined);
    }
  };

  try {
    if (folderPath) await to.createDirectory(folderPath, { mode: 'ensure', createParents: true });
    if (companion && targetCompanion) {
      for (const relative of ['', ...companion.directories]) {
        const directory = relative ? workspacePathJoin(targetCompanion, relative) : targetCompanion;
        await to.createDirectory(directory, { mode: 'create', createParents: false });
        createdDirectories.push(directory);
      }
      for (const file of companion.files) {
        const written = await to.writeFile(
          workspacePathJoin(targetCompanion, file.relative),
          file.data,
          { mode: 'create', createParents: false, expectedVersion: null },
        );
        createdFiles.push({ path: written.path, version: written.version });
      }
    }
    // The file itself last: until it is there, nothing shows a half move.
    const written = await to.writeFile(target, data, {
      mode: 'create',
      createParents: true,
      expectedVersion: null,
    });
    createdFiles.push({ path: written.path, version: written.version });
  } catch (error: unknown) {
    await undo();
    throw error;
  }

  try {
    await from.remove(sourcePath, { expectedVersion: read.entry.version });
  } catch (error: unknown) {
    await undo();
    throw error;
  }

  if (companion) {
    // The file has moved; what is left is tidying. Each companion file goes
    // only as it was copied, then the folders that are empty after that.
    for (const file of companion.files) {
      await from
        .remove(workspacePathJoin(companion.root, file.relative), {
          missing: 'ignore',
          expectedVersion: file.version,
        })
        .catch(() => undefined);
    }
    for (const relative of [...companion.directories].reverse()) {
      await from
        .remove(workspacePathJoin(companion.root, relative), { missing: 'ignore' })
        .catch(() => undefined);
    }
    await from.remove(companion.root, { missing: 'ignore' }).catch(() => undefined);
  }
  return target;
}
