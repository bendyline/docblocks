import { getFileSystemProviderV2, type FileSystemProvider } from './types.js';
import {
  describeEntryMove,
  describePartialMove,
  FileSystemMoveRecoveryError,
  FileSystemPartialMoveError,
} from './move-error.js';
import { parseWorkspacePath } from './workspace-path.js';

function normalisePath(path: string): string {
  return parseWorkspacePath(path);
}

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

/** Return the hidden companion directory used for a document's media and versions. */
export function documentCompanionPath(documentPath: string): string {
  const rooted = documentPath.replace(/\\/g, '/').startsWith('/');
  const clean = parseWorkspacePath(documentPath);
  if (!clean) throw new Error('The workspace root has no document companion path.');
  const parent = dirname(clean);
  const name = basename(clean).replace(/\.[^.]+$/, '');
  if (parent) return `${parent}/${name}_files`;
  return rooted ? `/${name}_files` : `${name}_files`;
}

function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(basename(path));
}

/**
 * Move an explorer entry without overwriting an existing entry. Markdown files
 * carry their hidden `<basename>_files` companion directory with them.
 */
export async function moveFileSystemEntry(
  provider: FileSystemProvider,
  oldPath: string,
  newPath: string,
  kind: 'file' | 'directory',
): Promise<void> {
  const providerV2 = getFileSystemProviderV2(provider);
  const exists = (candidate: string): Promise<boolean> =>
    providerV2
      ? providerV2.stat(parseWorkspacePath(candidate)).then((entry) => entry !== null)
      : provider.exists(candidate);
  const move = (source: string, destination: string): Promise<void> =>
    providerV2
      ? providerV2
          .move(parseWorkspacePath(source), parseWorkspacePath(destination), {
            createParents: true,
          })
          .then(() => undefined)
      : provider.rename(source, destination);

  const oldNormalised = normalisePath(oldPath);
  const newNormalised = normalisePath(newPath);
  if (oldNormalised === newNormalised) return;

  if (kind === 'directory' && newNormalised.startsWith(`${oldNormalised}/`)) {
    throw new Error('A folder cannot be moved into itself.');
  }
  if (await exists(newPath)) {
    throw new Error(`An entry named "${basename(newPath)}" already exists there.`);
  }

  let oldCompanion: string | null = null;
  let newCompanion: string | null = null;
  if (kind === 'file' && isMarkdownPath(oldPath)) {
    const candidate = documentCompanionPath(oldPath);
    if (await exists(candidate)) {
      oldCompanion = candidate;
      newCompanion = documentCompanionPath(newPath);
      if (
        normalisePath(oldCompanion) !== normalisePath(newCompanion) &&
        (await exists(newCompanion))
      ) {
        throw new Error(`The companion folder "${basename(newCompanion)}" already exists there.`);
      }
    }
  }

  try {
    await move(oldPath, newPath);
  } catch (error: unknown) {
    const state = await describeEntryMove(provider, oldPath, newPath);
    if (state.source === 'present' && state.destination === 'missing') throw error;
    throw new FileSystemMoveRecoveryError(oldPath, newPath, state, error);
  }
  if (!oldCompanion || !newCompanion) return;

  try {
    await move(oldCompanion, newCompanion);
  } catch (error: unknown) {
    // Keep the document and its assets together when the second half fails.
    try {
      await move(newPath, oldPath);
    } catch (rollbackError: unknown) {
      const state = await describePartialMove(
        provider,
        oldPath,
        newPath,
        oldCompanion,
        newCompanion,
      );
      throw new FileSystemPartialMoveError(
        oldPath,
        newPath,
        oldCompanion,
        newCompanion,
        state,
        error,
        rollbackError,
      );
    }
    const state = await describePartialMove(provider, oldPath, newPath, oldCompanion, newCompanion);
    const restoredSourceOnly =
      state.source === 'present' &&
      state.destination === 'missing' &&
      state.companionSource === 'present' &&
      state.companionDestination === 'missing';
    if (!restoredSourceOnly) {
      throw new FileSystemPartialMoveError(
        oldPath,
        newPath,
        oldCompanion,
        newCompanion,
        state,
        error,
        null,
      );
    }
    throw error;
  }
}
