import {
  FileSystemContentContainer,
  isDocumentMediaPath,
  resolveDocumentRelativeMediaPath,
  tryParseWorkspacePath,
  type FileSystemProvider,
  type WorkspacePath,
} from '@bendyline/docblocks/filesystem';
import { hostSupports, maybeGetDocBlocksHost } from '@bendyline/docblocks/host';
import { getTransientWorkspace } from '@bendyline/docblocks/workspace';
import type { ContentContainer } from '@bendyline/squisq/storage';

/** Reads a media file beside a loose OS-opened document, relative to its folder. */
export type LooseFileMediaReader = (path: WorkspacePath) => Promise<ArrayBuffer | null>;

/**
 * The host's read for media beside the document a loose-file session
 * workspace was opened from, or null for every other workspace.
 */
export function looseFileMediaReader(workspaceId: string): LooseFileMediaReader | null {
  const origin = getTransientWorkspace(workspaceId)?.descriptor.origin;
  if (origin?.kind !== 'loose-file' || !hostSupports('externalRelativeMedia')) return null;
  const external = maybeGetDocBlocksHost()?.external;
  if (!external?.readRelativeMedia) return null;
  const { resourceId } = origin;
  return async (path) => (await external.readRelativeMedia?.(resourceId, path)) ?? null;
}

/**
 * A loose OS-opened document's media container. Its session workspace holds
 * only the document, and its root stands for the file's folder, so media the
 * session does not hold -- the `_files` sidecar included -- is read from beside
 * the file on disk. Read-only: writes still land in the session workspace.
 */
class LooseFileMediaContainer extends FileSystemContentContainer {
  constructor(
    provider: FileSystemProvider,
    private readonly directory: string,
    private readonly readBeside: LooseFileMediaReader,
  ) {
    super(provider, directory);
  }

  override async readFile(path: string): Promise<ArrayBuffer | null> {
    const data = await super.readFile(path);
    if (data) return data;
    const beside = tryParseWorkspacePath(this.directory ? `${this.directory}/${path}` : path);
    if (!beside || !isDocumentMediaPath(beside)) return null;
    // Best effort, like the document-relative fallback: a refusal is absence.
    return this.readBeside(beside).catch(() => null);
  }
}

/** The container media resolves through, scoped to `directory` of the workspace. */
export function createMediaContainer(
  provider: FileSystemProvider,
  directory: string,
  readBesideLooseFile: LooseFileMediaReader | null,
): FileSystemContentContainer {
  return readBesideLooseFile
    ? new LooseFileMediaContainer(provider, directory, readBesideLooseFile)
    : new FileSystemContentContainer(provider, directory);
}

/**
 * The read-only fallback behind `createFileMediaProvider` for references
 * written relative to the document (`shots/a.png`) rather than to its sidecar.
 * `root` is a container scoped to the workspace root.
 */
export function createDocumentRelativeMediaReader(
  root: ContentContainer,
  documentDirectory: string,
): (ref: string) => Promise<ArrayBuffer | null> {
  return async (ref) => {
    const path = resolveDocumentRelativeMediaPath(documentDirectory, ref);
    return path === null ? null : root.readFile(path);
  };
}
