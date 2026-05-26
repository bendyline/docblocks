/**
 * ExportDialog — modal for choosing export format and options.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { getThemeSummaries } from '@bendyline/squisq/schemas';
import type { ExportFormat, ExportOptions, HtmlBundle, HtmlStyle } from './export-options.js';
import { FORMAT_LABELS, saveExportOptions } from './export-options.js';
import { loadTransformStyleSummaries, type ExportSummaryOption } from './transform-summaries.js';

export interface ExportDialogProps {
  /** Initial options (pre-populated from last export). */
  initial: ExportOptions;
  /** Whether the export is currently running. */
  exporting: boolean;
  /** Called when the user confirms the export. */
  onExport: (options: ExportOptions) => void;
  /** Called when the dialog is dismissed. */
  onClose: () => void;
}

const FORMATS: ExportFormat[] = ['pdf', 'docx', 'pptx', 'html', 'md'];

/** Short labels for the Format chip row. The fuller `FORMAT_LABELS` list
 *  is still used as a tooltip so users can confirm the file extension. */
const FORMAT_CHIP_LABELS: Record<ExportFormat, string> = {
  pdf: 'PDF',
  docx: 'Word',
  pptx: 'PowerPoint',
  html: 'HTML',
  md: 'Markdown',
};

const HTML_STYLE_CHIPS: { key: HtmlStyle; label: string; hint: string }[] = [
  {
    key: 'plain',
    label: 'Plain',
    hint: 'A lightweight static HTML document.',
  },
  {
    key: 'rendered',
    label: 'Rendered',
    hint: 'Renders via SquisqPlayer with themes and playback support.',
  },
];

const HTML_BUNDLE_CHIPS: { key: HtmlBundle; label: string; hint: string }[] = [
  {
    key: 'single',
    label: 'Single file',
    hint: 'One .html file with images embedded as base64 data URIs.',
  },
  {
    key: 'zip',
    label: 'ZIP archive',
    hint: 'A .zip with index.html plus separate image (and JS) files.',
  },
];

interface ChipOption<T extends string> {
  key: T;
  label: string;
  title?: string;
}

function ChipRadioGroup<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: T;
  options: ChipOption<T>[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="db-export-chips" role="radiogroup" aria-label={name}>
      {options.map((opt) => {
        const active = opt.key === value;
        return (
          <button
            key={opt.key}
            type="button"
            role="radio"
            aria-checked={active}
            className={`db-export-chip${active ? ' db-export-chip--active' : ''}`}
            onClick={() => onChange(opt.key)}
            title={opt.title}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function ExportDialog({ initial, exporting, onExport, onClose }: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>(initial.format);
  const [themeId, setThemeId] = useState(initial.themeId);
  const [transformStyle, setTransformStyle] = useState(initial.transformStyle);
  const [pageSize, setPageSize] = useState(initial.pageSize);
  const [htmlStyle, setHtmlStyle] = useState<HtmlStyle>(initial.htmlStyle);
  const [htmlBundle, setHtmlBundle] = useState<HtmlBundle>(initial.htmlBundle);
  const [includeLinkedDocs, setIncludeLinkedDocs] = useState<boolean>(initial.includeLinkedDocs);
  const [entryAsIndex, setEntryAsIndex] = useState<boolean>(initial.entryAsIndex);
  const [transforms, setTransforms] = useState<ExportSummaryOption[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);

  const themes = getThemeSummaries();

  // Both HTML styles honor themes now: rendered HTML through the
  // SquisqPlayer's theme system, plain HTML through squisq's
  // `markdownDocToPlainHtml` which emits theme-driven CSS variables
  // and Google Fonts links. Show the dropdown for any export format
  // whose pipeline actually applies the picked theme.
  const showTheme = format === 'docx' || format === 'pdf' || format === 'pptx' || format === 'html';
  const showTransform = format === 'pptx';
  const showPageSize = format === 'pdf';
  const showHtmlOptions = format === 'html';
  // Both HTML styles now have a recursive bundle: plain via
  // `markdownDocsToPlainHtmlBundle`, rendered via
  // `markdownDocsToHtmlBundle` (which rewrites Doc-tree links to
  // `.html` before SquisqPlayer serialization). So the option applies
  // to any HTML export.
  const showIncludeLinked = format === 'html';
  // Multi-doc output is inherently a directory tree, so when recursion
  // is on the Bundle row would only confuse — ZIP is the only valid
  // packaging. Hide the chip row and surface the implication in a hint.
  const showHtmlBundle = showHtmlOptions && !includeLinkedDocs;
  // `entryAsIndex` is only honored in pipelines where we control the
  // output filename ourselves:
  //   • single-file HTML downloads → renames `<doc>.html` → `index.html`
  //   • recursive bundles → passed through to squisq's bundle helpers
  // In the single-doc ZIP path, squisq's `docToHtmlZip` and our plain-
  // HTML zip writer always emit `index.html` inside the archive, so the
  // checkbox has no observable effect — hide it to avoid surfacing an
  // inert control.
  const showEntryAsIndex = showHtmlOptions && (htmlBundle === 'single' || includeLinkedDocs);

  useEffect(() => {
    if (!showTransform) return;
    let cancelled = false;

    loadTransformStyleSummaries()
      .then((nextTransforms) => {
        if (!cancelled) setTransforms(nextTransforms);
      })
      .catch(() => {
        if (!cancelled) setTransforms([]);
      });

    return () => {
      cancelled = true;
    };
  }, [showTransform]);

  const handleExport = useCallback(() => {
    const opts: ExportOptions = {
      format,
      themeId,
      transformStyle,
      pageSize,
      htmlStyle,
      htmlBundle,
      includeLinkedDocs: showIncludeLinked && includeLinkedDocs,
      entryAsIndex: showEntryAsIndex && entryAsIndex,
    };
    saveExportOptions(opts);
    onExport(opts);
  }, [
    format,
    themeId,
    transformStyle,
    pageSize,
    htmlStyle,
    htmlBundle,
    includeLinkedDocs,
    entryAsIndex,
    showIncludeLinked,
    showEntryAsIndex,
    onExport,
  ]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Close on backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  return (
    <div className="db-dialog-overlay" onClick={handleBackdropClick}>
      <div className="db-dialog db-export-dialog" ref={dialogRef}>
        <div className="db-dialog-header">
          <h2 className="db-dialog-title">Export Document</h2>
          <button className="db-dialog-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="db-dialog-body">
          {/* Format — chip radio row for fast switching */}
          <div className="db-export-field">
            <span className="db-export-label">Format</span>
            <ChipRadioGroup
              name="Format"
              value={format}
              options={FORMATS.map((f) => ({
                key: f,
                label: FORMAT_CHIP_LABELS[f],
                title: FORMAT_LABELS[f],
              }))}
              onChange={setFormat}
            />
          </div>

          {/* HTML style + bundle (HTML only) — also chip rows */}
          {showHtmlOptions && (
            <>
              <div className="db-export-field">
                <span className="db-export-label">Style</span>
                <ChipRadioGroup
                  name="Style"
                  value={htmlStyle}
                  options={HTML_STYLE_CHIPS}
                  onChange={setHtmlStyle}
                />
                <span className="db-export-hint">
                  {HTML_STYLE_CHIPS.find((c) => c.key === htmlStyle)?.hint}
                </span>
              </div>
              {showHtmlBundle && (
                <div className="db-export-field">
                  <span className="db-export-label">Bundle</span>
                  <ChipRadioGroup
                    name="Bundle"
                    value={htmlBundle}
                    options={HTML_BUNDLE_CHIPS}
                    onChange={setHtmlBundle}
                  />
                  <span className="db-export-hint">
                    {HTML_BUNDLE_CHIPS.find((c) => c.key === htmlBundle)?.hint}
                  </span>
                </div>
              )}
              {showIncludeLinked && (
                <div className="db-export-field">
                  <label className="db-export-checkbox">
                    <input
                      type="checkbox"
                      checked={includeLinkedDocs}
                      onChange={(e) => setIncludeLinkedDocs(e.target.checked)}
                    />
                    <span>Include linked-to documents</span>
                  </label>
                  <span className="db-export-hint">
                    {includeLinkedDocs
                      ? 'Follows relative .md links from this page and bundles every reachable document as its own .html in a ZIP. Cross-doc links rewrite from .md to .html.'
                      : 'Only this document is exported.'}
                  </span>
                </div>
              )}
              {showEntryAsIndex && (
                <div className="db-export-field">
                  <label className="db-export-checkbox">
                    <input
                      type="checkbox"
                      checked={entryAsIndex}
                      onChange={(e) => setEntryAsIndex(e.target.checked)}
                    />
                    <span>Name entry page index.html</span>
                  </label>
                  <span className="db-export-hint">
                    {entryAsIndex
                      ? includeLinkedDocs
                        ? 'Renames this page to index.html in the ZIP and rewrites any cross-doc links pointing back at it. Drops straight into a static-site host.'
                        : 'Downloads as index.html instead of the document name. Drops straight into a static-site host.'
                      : 'Exports under the document name.'}
                  </span>
                </div>
              )}
            </>
          )}

          {/* Theme */}
          {showTheme && (
            <div className="db-export-field">
              <label className="db-export-label" htmlFor="db-export-theme">
                Theme
              </label>
              <select
                id="db-export-theme"
                className="db-export-select"
                value={themeId}
                onChange={(e) => setThemeId(e.target.value)}
              >
                {themes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <span className="db-export-hint">
                {themes.find((t) => t.id === themeId)?.description}
              </span>
            </div>
          )}

          {/* Transform (PPTX only) */}
          {showTransform && (
            <div className="db-export-field">
              <label className="db-export-label" htmlFor="db-export-transform">
                Transform
              </label>
              <select
                id="db-export-transform"
                className="db-export-select"
                value={transformStyle}
                onChange={(e) => setTransformStyle(e.target.value)}
              >
                {transforms.length === 0 ? (
                  <option value={transformStyle}>Loading...</option>
                ) : (
                  transforms.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))
                )}
              </select>
              <span className="db-export-hint">
                {transforms.find((t) => t.id === transformStyle)?.description}
              </span>
            </div>
          )}

          {/* Page size (PDF only) */}
          {showPageSize && (
            <div className="db-export-field">
              <label className="db-export-label" htmlFor="db-export-pagesize">
                Page Size
              </label>
              <select
                id="db-export-pagesize"
                className="db-export-select"
                value={pageSize}
                onChange={(e) => setPageSize(e.target.value as 'letter' | 'a4')}
              >
                <option value="letter">US Letter</option>
                <option value="a4">A4</option>
              </select>
            </div>
          )}
        </div>

        <div className="db-export-footer">
          <button className="db-export-btn db-export-btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="db-export-btn db-export-btn--primary"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? 'Exporting...' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}
