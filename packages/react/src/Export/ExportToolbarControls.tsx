/**
 * ExportToolbarControls — toolbar-right slot content.
 *
 * Renders a "..." overflow menu on the right side of the toolbar
 * containing export actions (document export + video export).
 *
 * Must be rendered inside <EditorProvider> so useEditorContext() works.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useEditorContext } from '@bendyline/squisq-editor-react';
import { getThemeSummaries } from '@bendyline/squisq/schemas';
import { getTransformStyleSummaries } from '@bendyline/squisq/transform';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { VideoExportModal } from '@bendyline/squisq-video-react';
import { PLAYER_BUNDLE } from '@bendyline/squisq-react/standalone-source';
import type { ExportOptions } from './export-options.js';
import {
  DEFAULT_OPTIONS,
  FORMAT_EXTENSIONS,
  loadLastExportOptions,
  saveExportOptions,
} from './export-options.js';
import { ExportDialog } from './ExportDialog.js';
import { runExport } from './run-export.js';

export interface ExportToolbarControlsProps {
  /** Currently selected file path — used to derive the download filename. */
  selectedFile: string | null;
}

/** Build the quick-export label from saved options. */
function quickLabel(opts: ExportOptions): string {
  const ext = FORMAT_EXTENSIONS[opts.format].toUpperCase().replace('.', '');
  const parts: string[] = [];

  if (opts.themeId !== 'standard') {
    const theme = getThemeSummaries().find((t) => t.id === opts.themeId);
    if (theme) parts.push(theme.name);
  }
  if (opts.format === 'pptx' && opts.transformStyle) {
    const transform = getTransformStyleSummaries().find((t) => t.id === opts.transformStyle);
    if (transform) parts.push(transform.name);
  }

  if (parts.length > 0) {
    return `Export ${ext} with ${parts.join(' + ')}`;
  }
  return `Export ${ext}`;
}

export function ExportToolbarControls({ selectedFile }: ExportToolbarControlsProps) {
  const { markdownSource } = useEditorContext();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const lastOptions = loadLastExportOptions();

  /** Build a Doc from the current markdown for video export. */
  const doc = useMemo(() => {
    if (!videoModalOpen) return null;
    const mdDoc = parseMarkdown(markdownSource);
    return markdownToDoc(mdDoc);
  }, [videoModalOpen, markdownSource]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  const handleToggleMenu = useCallback(() => {
    setMenuOpen((prev) => !prev);
  }, []);

  const handleOpenDialog = useCallback(() => {
    setMenuOpen(false);
    setDialogOpen(true);
  }, []);

  const handleCloseDialog = useCallback(() => {
    setDialogOpen(false);
  }, []);

  const handleOpenVideoModal = useCallback(() => {
    setMenuOpen(false);
    setVideoModalOpen(true);
  }, []);

  const handleCloseVideoModal = useCallback(() => {
    setVideoModalOpen(false);
  }, []);

  const handleExport = useCallback(
    async (opts: ExportOptions) => {
      setExporting(true);
      try {
        await runExport(markdownSource, selectedFile, opts);
      } finally {
        setExporting(false);
        setDialogOpen(false);
      }
    },
    [markdownSource, selectedFile],
  );

  const handleQuickExport = useCallback(async () => {
    if (!lastOptions) return;
    setMenuOpen(false);
    setExporting(true);
    try {
      saveExportOptions(lastOptions);
      await runExport(markdownSource, selectedFile, lastOptions);
    } finally {
      setExporting(false);
    }
  }, [lastOptions, markdownSource, selectedFile]);

  return (
    <>
      <div className="db-toolbar-menu" ref={menuRef}>
        <button
          className="db-toolbar-menu-trigger"
          onClick={handleToggleMenu}
          aria-label="More actions"
          title="More actions"
        >
          &middot;&middot;&middot;
        </button>

        {menuOpen && (
          <div className="db-toolbar-menu-dropdown">
            {lastOptions && (
              <button
                className="db-toolbar-menu-item"
                onClick={handleQuickExport}
                disabled={exporting}
              >
                {quickLabel(lastOptions)}
              </button>
            )}
            <button className="db-toolbar-menu-item" onClick={handleOpenDialog}>
              Export...
            </button>
            <div className="db-toolbar-menu-divider" />
            <button className="db-toolbar-menu-item" onClick={handleOpenVideoModal}>
              Export Video...
            </button>
          </div>
        )}
      </div>

      {dialogOpen && (
        <ExportDialog
          initial={lastOptions ?? DEFAULT_OPTIONS}
          exporting={exporting}
          onExport={handleExport}
          onClose={handleCloseDialog}
        />
      )}

      {videoModalOpen && doc && (
        <VideoExportModal
          doc={doc}
          playerScript={PLAYER_BUNDLE}
          onClose={handleCloseVideoModal}
        />
      )}
    </>
  );
}
