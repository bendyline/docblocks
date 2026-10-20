/**
 * Export option types and localStorage persistence for quick-export.
 */

import { getThemeSummaries } from '@bendyline/squisq/schemas';

export type ExportFormat = 'docx' | 'pdf' | 'pptx' | 'epub' | 'md' | 'html';

/** Visual style for HTML export. */
export type HtmlStyle =
  /** Render via SquisqPlayer (themed, embeds player bundle). */
  | 'rendered'
  /** Plain semantic HTML — small, no JS, no playback. */
  | 'plain';

/** Packaging for HTML export. */
export type HtmlBundle =
  /** Single self-contained .html file (images base64-embedded). */
  | 'single'
  /** ZIP containing index.html + asset files. */
  | 'zip';

export interface ExportOptions {
  format: ExportFormat;
  themeId: string;
  /** Transform style for PPTX; an empty string explicitly disables transforms. */
  transformStyle: string;
  /** Only applies to PDF */
  pageSize: 'letter' | 'a4';
  /** HTML rendering style. Only applies to format=html. */
  htmlStyle: HtmlStyle;
  /** HTML bundle layout. Only applies to format=html. */
  htmlBundle: HtmlBundle;
  /**
   * Recursive HTML bundle: walk relative `.md` links from the entry
   * document, render every reachable sibling/child page, and rewrite
   * cross-doc links from `.md` → `.html`. The output is a ZIP
   * regardless of `htmlBundle` because multi-doc output needs a
   * directory tree. Supported for both plain (`markdownDocsToPlainHtmlBundle`)
   * and rendered (`markdownDocsToHtmlBundle`) HTML styles. Only
   * meaningful when `format === 'html'`.
   */
  includeLinkedDocs: boolean;
  /**
   * Rename the entry page from `<basename>.html` to `index.html` so the
   * export drops straight into a static-site host that expects an
   * `index.html` landing page. For recursive bundles, cross-doc links
   * targeting the entry also rewrite to `index.html` so siblings don't
   * 404. For a single-doc HTML download, this just renames the file.
   * Only meaningful when `format === 'html'`.
   */
  entryAsIndex: boolean;
}

export const FORMAT_LABELS: Record<ExportFormat, string> = {
  docx: 'Word Document (.docx)',
  pdf: 'PDF (.pdf)',
  pptx: 'PowerPoint (.pptx)',
  epub: 'EPUB e-book (.epub)',
  md: 'Markdown (.md)',
  html: 'HTML (.html)',
};

export const FORMAT_EXTENSIONS: Record<ExportFormat, string> = {
  docx: '.docx',
  pdf: '.pdf',
  pptx: '.pptx',
  epub: '.epub',
  md: '.md',
  html: '.html',
};

const STORAGE_KEY = 'docblocks-export-options';

export const DEFAULT_OPTIONS: ExportOptions = {
  format: 'pdf',
  themeId: 'standard',
  transformStyle: 'documentary',
  pageSize: 'letter',
  htmlStyle: 'plain',
  htmlBundle: 'single',
  includeLinkedDocs: false,
  entryAsIndex: false,
};

/**
 * Options that populate the export dialog: the user's last-chosen options
 * (else the built-in defaults) for format, page size and the rest, but always
 * the theme the editor previews this document in -- its own theme, else the
 * workspace default, else Standard. The last export's theme belonged to some
 * other document; carrying it over made the export differ from the preview.
 */
export function resolveExportDialogInitial(
  lastOptions: ExportOptions | null,
  docThemeId: string | null | undefined,
  workspaceThemeId?: string | null,
): ExportOptions {
  const base = lastOptions ?? DEFAULT_OPTIONS;
  return { ...base, themeId: docThemeId || workspaceThemeId || DEFAULT_OPTIONS.themeId };
}

/** A theme as the export dialog's Theme select lists it. */
export interface ExportThemeSummary {
  id: string;
  name: string;
  description?: string;
}

/**
 * The export dialog's theme choices: the document's own themes first (the one
 * it previews in may be among them), then every built-in they do not shadow.
 */
export function exportThemeChoices(
  documentThemes: readonly ExportThemeSummary[] = [],
): ExportThemeSummary[] {
  const ids = new Set(documentThemes.map((theme) => theme.id));
  return [...documentThemes, ...getThemeSummaries().filter((theme) => !ids.has(theme.id))];
}

export function loadLastExportOptions(): ExportOptions | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ExportOptions>;
    return { ...DEFAULT_OPTIONS, ...parsed };
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
