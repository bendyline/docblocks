/**
 * Which glyph a file-tree row wears beside its name. A kind folder wears its
 * kind's glyph, the same one its place button in the sidebar header shows;
 * any other folder wears a folder. A file wears its type's glyph, read from
 * its extension, and a plain page when the extension says nothing.
 */

import type { FileSystemEntry } from '@bendyline/docblocks/filesystem';
import type { FolderKind } from '@bendyline/docblocks/folders';
import { extensionOfFileName } from '../DocBlocksShell/import-file-types.js';

/** The families of file the tree tells apart. */
export type FileTypeGlyph =
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'web'
  | 'image'
  | 'video'
  | 'audio'
  | 'code'
  | 'data'
  | 'archive'
  | 'file';

export type TreeEntryGlyph = 'folder' | FolderKind | FileTypeGlyph;

const FILE_TYPES: Readonly<Record<Exclude<FileTypeGlyph, 'file'>, readonly string[]>> = {
  document: [
    '.md',
    '.markdown',
    '.mdown',
    '.txt',
    '.text',
    '.rtf',
    '.docx',
    '.doc',
    '.odt',
    '.pdf',
  ],
  spreadsheet: ['.xlsx', '.xlsm', '.xls', '.ods', '.csv', '.tsv'],
  presentation: ['.pptx', '.ppt', '.odp', '.key'],
  web: ['.html', '.htm'],
  image: [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.avif',
    '.bmp',
    '.svg',
    '.ico',
    '.heic',
    '.heif',
    '.tif',
    '.tiff',
  ],
  video: ['.mp4', '.m4v', '.mov', '.webm', '.ogv', '.mkv', '.avi'],
  audio: ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac', '.weba'],
  code: [
    '.js',
    '.mjs',
    '.cjs',
    '.jsx',
    '.ts',
    '.tsx',
    '.py',
    '.rb',
    '.go',
    '.rs',
    '.c',
    '.cc',
    '.cpp',
    '.h',
    '.hpp',
    '.cs',
    '.java',
    '.kt',
    '.kts',
    '.swift',
    '.php',
    '.lua',
    '.sh',
    '.bash',
    '.zsh',
    '.css',
    '.scss',
    '.less',
    '.sql',
  ],
  data: ['.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.ini'],
  archive: ['.zip', '.dbk', '.gz', '.tgz', '.tar', '.7z', '.rar'],
};

const FILE_TYPE_BY_EXTENSION: ReadonlyMap<string, FileTypeGlyph> = new Map(
  (Object.entries(FILE_TYPES) as [FileTypeGlyph, readonly string[]][]).flatMap(
    ([glyph, extensions]) => extensions.map((extension) => [extension, glyph] as const),
  ),
);

/** The glyph for a file named `name`. */
export function fileTypeGlyph(name: string): FileTypeGlyph {
  return FILE_TYPE_BY_EXTENSION.get(extensionOfFileName(name)) ?? 'file';
}

/**
 * The glyph for a tree row. `folderKind` is the kind of the folder at the
 * entry's own path, if it is a kind folder; a folder inside one (a tasks
 * folder's lists, say) is an ordinary folder.
 */
export function treeEntryGlyph(
  entry: Pick<FileSystemEntry, 'kind' | 'name'>,
  folderKind?: FolderKind | null,
): TreeEntryGlyph {
  if (entry.kind === 'directory') return folderKind ?? 'folder';
  return fileTypeGlyph(entry.name);
}
