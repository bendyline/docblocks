/** File types accepted by the workspace drag-and-drop importer. */

/** Rendered documents that keep their original file outside editable Markdown. */
export const OUTSIDE_IN_IMPORT_EXTENSIONS = new Set([
  '.csv',
  '.docx',
  '.html',
  '.htm',
  '.pdf',
  '.pptx',
  '.xlsx',
]);

/** Workspace bundles decoded into their primary Markdown document. */
export const BUNDLE_IMPORT_EXTENSIONS = new Set(['.dbk', '.zip']);

/**
 * Common text, source, data, and browser-viewable image formats. Browsers
 * frequently leave `File.type` empty for source files, so extensions remain
 * necessary even though MIME families provide the broader fallback below.
 */
export const DIRECT_IMPORT_EXTENSIONS = new Set([
  '.avif',
  '.bash',
  '.bmp',
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.gif',
  '.go',
  '.h',
  '.hpp',
  '.ico',
  '.ini',
  '.java',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.jsonc',
  '.jsx',
  '.kt',
  '.kts',
  '.less',
  '.log',
  '.lua',
  '.markdown',
  '.md',
  '.mdown',
  '.mjs',
  '.php',
  '.png',
  '.py',
  '.rb',
  '.rs',
  '.scss',
  '.sh',
  '.sql',
  '.svg',
  '.swift',
  '.toml',
  '.ts',
  '.tsv',
  '.tsx',
  '.txt',
  '.webp',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh',
]);

const DIRECT_IMPORT_BASENAMES = new Set(['dockerfile', 'license', 'makefile', 'readme']);

/**
 * What the status line says while files import. Converting a Word, PDF or
 * spreadsheet file can take many seconds on first use, and an import that
 * shows nothing until it finishes looks like a drop that failed.
 */
export function importingMessage(files: readonly Pick<File, 'name'>[]): string {
  const first = files[0];
  const subject = files.length === 1 && first ? `“${first.name}”` : `${String(files.length)} files`;
  const converting = files.some((file) =>
    OUTSIDE_IN_IMPORT_EXTENSIONS.has(extensionOfFileName(file.name)),
  );
  return converting
    ? `Importing ${subject}… Converting documents can take a few seconds.`
    : `Importing ${subject}…`;
}

/**
 * `accept` for the Import files picker: everything the importer takes, so
 * the system dialog lists exactly the files that will work.
 */
export const IMPORT_ACCEPT = [
  ...OUTSIDE_IN_IMPORT_EXTENSIONS,
  ...BUNDLE_IMPORT_EXTENSIONS,
  ...DIRECT_IMPORT_EXTENSIONS,
  'text/*',
  'image/*',
].join(',');

export function extensionOfFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

export function isSupportedImportFile(file: Pick<File, 'name' | 'type'>): boolean {
  const extension = extensionOfFileName(file.name);
  if (
    OUTSIDE_IN_IMPORT_EXTENSIONS.has(extension) ||
    BUNDLE_IMPORT_EXTENSIONS.has(extension) ||
    DIRECT_IMPORT_EXTENSIONS.has(extension)
  ) {
    return true;
  }

  const mimeType = file.type.toLowerCase();
  if (mimeType.startsWith('text/') || mimeType.startsWith('image/')) return true;
  return !extension && DIRECT_IMPORT_BASENAMES.has(file.name.toLowerCase());
}

/**
 * Whether a MIME type names media Squisq inserts itself at the drop point:
 * images as images, video and audio as inline players. During dragover a
 * dragged item exposes only this type, not its file name.
 */
export function isEditorMediaMimeType(mimeType: string): boolean {
  return /^(?:image|video|audio)\//i.test(mimeType);
}

/**
 * Files the *editor pane* accepts as a document import.
 *
 * Narrower than `isSupportedImportFile` on purpose. Squisq already handles
 * image, video and audio drops by placing them in the document at the drop
 * point, which is almost always what someone dragging a PNG or an MP4 onto a
 * page wants. Intercepting those would replace a good behaviour with a worse
 * one, so media is deliberately excluded here and left to fall through.
 */
export function isEditorDocumentImportFile(file: Pick<File, 'name' | 'type'>): boolean {
  if (isEditorMediaMimeType(file.type)) return false;
  const extension = extensionOfFileName(file.name);
  if (DIRECT_IMPORT_IMAGE_EXTENSIONS.has(extension)) return false;
  return isSupportedImportFile(file);
}

/** Image extensions inside DIRECT_IMPORT_EXTENSIONS, which Squisq handles itself. */
const DIRECT_IMPORT_IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
]);
