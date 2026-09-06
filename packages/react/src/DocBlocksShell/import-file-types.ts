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
