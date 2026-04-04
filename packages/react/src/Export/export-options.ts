/**
 * Export option types and localStorage persistence for quick-export.
 */

export type ExportFormat = 'docx' | 'pdf' | 'pptx' | 'md' | 'html';

export interface ExportOptions {
  format: ExportFormat;
  themeId: string;
  /** Transform style for PPTX — controls how content is segmented and styled. */
  transformStyle: string;
  /** Only applies to PDF */
  pageSize: 'letter' | 'a4';
}

export const FORMAT_LABELS: Record<ExportFormat, string> = {
  docx: 'Word Document (.docx)',
  pdf: 'PDF (.pdf)',
  pptx: 'PowerPoint (.pptx)',
  md: 'Markdown (.md)',
  html: 'HTML (.html)',
};

export const FORMAT_EXTENSIONS: Record<ExportFormat, string> = {
  docx: '.docx',
  pdf: '.pdf',
  pptx: '.pptx',
  md: '.md',
  html: '.html',
};

const STORAGE_KEY = 'docblocks-export-options';

export const DEFAULT_OPTIONS: ExportOptions = {
  format: 'pdf',
  themeId: 'standard',
  transformStyle: 'documentary',
  pageSize: 'letter',
};

export function loadLastExportOptions(): ExportOptions | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ExportOptions;
  } catch {
    return null;
  }
}

export function saveExportOptions(options: ExportOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
  } catch {
    // Ignore storage errors
  }
}
