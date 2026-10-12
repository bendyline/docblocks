/**
 * FileSystemContentContainer — a ContentContainer backed by any
 * FileSystemProvider, scoped to a sub-path (e.g., ".docblocks/media/").
 *
 * Used by the Electron desktop app so media lives inside the workspace
 * folder (visible as regular files) rather than in a separate IndexedDB
 * origin that only the app can see.
 */

import type { ContentContainer, ContentEntry } from '@bendyline/squisq/storage';
import { findDocumentPath } from '@bendyline/squisq/storage';
import { FsError } from './fs-error.js';
import { getFileSystemProviderV2, type FileSystemProvider } from './types.js';
import { parseWorkspacePath, workspacePathContains, workspacePathJoin } from './workspace-path.js';
import { guessMimeType } from './internal/mime.js';

function joinPrefix(prefix: string, p: string): string {
  return workspacePathJoin(parseWorkspacePath(prefix), p);
}

/** The folder part of a listing prefix (`a/b/` → `a/b`), or '' when it is not canonical. */
function canonicalPrefixFolder(prefix: string | undefined): string {
  const folder = prefix?.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '';
  try {
    return folder && parseWorkspacePath(folder) === folder ? folder : '';
  } catch {
    // A non-canonical prefix matches no listed path; the pruned walk finds nothing.
    return '';
  }
}

export class FileSystemContentContainer implements ContentContainer {
  private readonly prefix: string;
  private readonly documentMediaPrefix: string;

  constructor(
    private readonly provider: FileSystemProvider,
    prefix = '.docblocks/media',
    options: { documentMediaPrefix?: string } = {},
  ) {
    this.prefix = parseWorkspacePath(prefix);
    this.documentMediaPrefix = parseWorkspacePath(options.documentMediaPrefix ?? '');
  }

  /** A document-scoped container also accepts the media references written
   * into its Markdown, e.g. notes_files/audio/take.webm. Version paths and
   * container-relative discovery still live directly under the scoped root. */
  private resolve(path: string): string {
    const canonical = parseWorkspacePath(path);
    const alias = this.documentMediaPrefix;
    return joinPrefix(
      this.prefix,
      alias && canonical.startsWith(`${alias}/`) ? canonical.slice(alias.length + 1) : canonical,
    );
  }

  async readFile(path: string): Promise<ArrayBuffer | null> {
    const full = this.resolve(path);
    const providerV2 = getFileSystemProviderV2(this.provider);
    if (providerV2) return (await providerV2.readFile(parseWorkspacePath(full)))?.data ?? null;
    const binary = await this.provider.readBinary(full);
    if (binary) return binary;
    // IndexedDB-backed workspaces store text via `writeFile(string)` and
    // binary via `writeBinary(ArrayBuffer)` under separate keys, so a
    // markdown file written through the text API is invisible to
    // `readBinary`. Fall back to text-then-UTF-8 so consumers like the
    // recursive HTML export can resolve sibling `.md` links uniformly
    // across browser and native workspaces.
    const text = await this.provider.readFile(full);
    if (text === null) return null;
    return new TextEncoder().encode(text).buffer as ArrayBuffer;
  }

  async writeFile(path: string, data: ArrayBuffer | Uint8Array, _mimeType?: string): Promise<void> {
    const full = this.resolve(path);
    const providerV2 = getFileSystemProviderV2(this.provider);
    if (providerV2) {
      await providerV2.writeFile(parseWorkspacePath(full), data, {
        mode: 'upsert',
        createParents: true,
      });
      return;
    }
    await this.provider.writeBinary(full, data);
  }

  async removeFile(path: string): Promise<void> {
    const full = this.resolve(path);
    const providerV2 = getFileSystemProviderV2(this.provider);
    if (providerV2) {
      await providerV2.remove(parseWorkspacePath(full), { missing: 'ignore' });
      return;
    }
    await this.provider.delete(full);
  }

  async listFiles(prefix?: string): Promise<ContentEntry[]> {
    const entries: ContentEntry[] = [];
    const providerV2 = getFileSystemProviderV2(this.provider);
    const root = parseWorkspacePath(this.prefix);
    // `WorkspacePath`s never carry a leading slash. When this container is
    // rooted at the workspace root, slicing `prefix.length + 1` therefore
    // drops the first character of every file path. Besides publishing
    // corrupt names, that makes prefix scans such as `notes_files/` return no
    // media at all. Only skip a separator when the container has a non-root
    // prefix.
    const relativePath = (childPath: string): string =>
      root ? (childPath === root ? '' : childPath.slice(root.length + 1)) : childPath;
    // Start at the deepest folder the prefix names, so `notes_files/` lists
    // one companion folder instead of walking the entire workspace.
    const prefixFolder = canonicalPrefixFolder(prefix);
    const start = prefixFolder ? workspacePathJoin(root, prefixFolder) : root;
    type ListedEntry = {
      readonly kind: 'file' | 'directory';
      readonly path: string;
      readonly size?: number | null;
    };
    const walk = async (dir: string) => {
      let children: readonly ListedEntry[];
      try {
        children = providerV2
          ? await providerV2.readDirectory(parseWorkspacePath(dir))
          : await this.provider.readDirectory(dir);
      } catch (error: unknown) {
        // An absent container root (or prefix folder) means no entries.
        // Every other storage fault (including a subtree disappearing
        // mid-snapshot) remains observable to backup/export callers.
        const absent =
          error instanceof FsError &&
          (error.code === 'not-found' || (dir !== root && error.code === 'type-mismatch'));
        if (dir === start && absent) return;
        throw error;
      }
      for (const child of children) {
        const childPath = parseWorkspacePath(child.path);
        if (child.kind === 'directory') {
          if (prefix && !`${relativePath(childPath)}/`.startsWith(prefix)) continue;
          await walk(child.path);
        } else {
          if (!workspacePathContains(root, childPath)) continue;
          const rel = relativePath(childPath);
          if (prefix && !rel.startsWith(prefix)) continue;
          const size = child.size ?? (await this.provider.stat(child.path))?.size ?? 0;
          entries.push({
            path: rel,
            mimeType: guessMimeType(rel),
            size,
          });
        }
      }
    };
    await walk(start);
    return entries;
  }

  async exists(path: string): Promise<boolean> {
    const full = this.resolve(path);
    const providerV2 = getFileSystemProviderV2(this.provider);
    return providerV2
      ? (await providerV2.stat(parseWorkspacePath(full))) !== null
      : this.provider.exists(full);
  }

  async getDocumentPath(): Promise<string | null> {
    return findDocumentPath(await this.listFiles());
  }

  async readDocument(): Promise<string | null> {
    const docPath = await this.getDocumentPath();
    if (!docPath) return null;
    const data = await this.readFile(docPath);
    if (!data) return null;
    return new TextDecoder().decode(data);
  }

  async writeDocument(markdown: string, filename?: string): Promise<void> {
    const name = filename ?? 'index.md';
    const data = new TextEncoder().encode(markdown);
    await this.writeFile(name, data, 'text/markdown');
  }
}
