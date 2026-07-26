import type { ExportOptions } from './export-options.js';
import { FORMAT_EXTENSIONS } from './export-options.js';

export function buildExportFilename(selectedFile: string | null, options: ExportOptions): string {
  const base = selectedFile ? selectedFile.replace(/^\//, '').replace(/\.[^.]+$/, '') : 'document';
  if (options.format === 'html') {
    if (options.includeLinkedDocs || options.htmlBundle === 'zip') return `${base}.zip`;
    if (options.entryAsIndex) return 'index.html';
  }
  return base + FORMAT_EXTENSIONS[options.format];
}
