/**
 * ExportDialog — modal for choosing export format and options.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { getThemeSummaries } from '@bendyline/squisq/schemas';
import { getTransformStyleSummaries } from '@bendyline/squisq/transform';
import type { ExportFormat, ExportOptions } from './export-options.js';
import { FORMAT_LABELS, saveExportOptions } from './export-options.js';

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

export function ExportDialog({ initial, exporting, onExport, onClose }: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>(initial.format);
  const [themeId, setThemeId] = useState(initial.themeId);
  const [transformStyle, setTransformStyle] = useState(initial.transformStyle);
  const [pageSize, setPageSize] = useState(initial.pageSize);
  const dialogRef = useRef<HTMLDivElement>(null);

  const themes = getThemeSummaries();
  const transforms = getTransformStyleSummaries();

  const showTheme = format === 'docx' || format === 'pdf' || format === 'pptx';
  const showTransform = format === 'pptx';
  const showPageSize = format === 'pdf';

  const handleExport = useCallback(() => {
    const opts: ExportOptions = { format, themeId, transformStyle, pageSize };
    saveExportOptions(opts);
    onExport(opts);
  }, [format, themeId, transformStyle, pageSize, onExport]);

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
          {/* Format */}
          <div className="db-export-field">
            <label className="db-export-label" htmlFor="db-export-format">
              Format
            </label>
            <select
              id="db-export-format"
              className="db-export-select"
              value={format}
              onChange={(e) => setFormat(e.target.value as ExportFormat)}
            >
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABELS[f]}
                </option>
              ))}
            </select>
          </div>

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
                {transforms.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
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
