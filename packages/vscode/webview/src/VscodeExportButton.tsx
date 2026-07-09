import { useCallback, useMemo, useRef, useState } from 'react';
import { useEditorContext } from '@bendyline/squisq-editor-react';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { ExportDialog } from '../../../react/src/Export/ExportDialog.js';
import {
  DEFAULT_OPTIONS,
  loadLastExportOptions,
  type ExportOptions,
} from '../../../react/src/Export/export-options.js';
import { buildExportFilename, runExport } from '../../../react/src/Export/run-export.js';

export interface VscodeExportButtonProps {
  selectedFile: string | null;
  mediaContainer: ContentContainer | null;
  saveBlob: (blob: Blob, filename: string, targetPath?: string | null) => Promise<string | null>;
  resolveExportTarget: (filename: string) => Promise<string>;
  pickExportTarget: (filename: string, currentPath?: string | null) => Promise<string | null>;
}

export function VscodeExportButton({
  selectedFile,
  mediaContainer,
  saveBlob,
  resolveExportTarget,
  pickExportTarget,
}: VscodeExportButtonProps) {
  const { markdownSource, markdownDoc } = useEditorContext();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [destinationPath, setDestinationPath] = useState('');
  const destinationLockedRef = useRef(false);
  const destinationRequestRef = useRef(0);

  const docThemeId = useMemo(() => {
    const frontmatter = markdownDoc?.frontmatter as Record<string, unknown> | undefined;
    if (!frontmatter) return null;
    const candidates = [frontmatter['squisq-theme'], frontmatter['theme'], frontmatter['themeId']];
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  }, [markdownDoc]);

  const dialogInitial = useMemo(() => {
    const base = loadLastExportOptions() ?? DEFAULT_OPTIONS;
    return docThemeId ? { ...base, themeId: docThemeId } : base;
  }, [docThemeId]);

  const refreshDestination = useCallback(
    async (options: ExportOptions, force = false) => {
      if (!force && destinationLockedRef.current) return;

      const requestId = destinationRequestRef.current + 1;
      destinationRequestRef.current = requestId;

      try {
        const filename = buildExportFilename(selectedFile, options);
        const path = await resolveExportTarget(filename);
        if (destinationRequestRef.current === requestId) setDestinationPath(path);
      } catch {
        if (destinationRequestRef.current === requestId) setDestinationPath('');
      }
    },
    [resolveExportTarget, selectedFile],
  );

  const handleOpenDialog = useCallback(() => {
    destinationLockedRef.current = false;
    setDialogOpen(true);
    void refreshDestination(dialogInitial, true);
  }, [dialogInitial, refreshDestination]);

  const handleDestinationChange = useCallback((path: string) => {
    destinationLockedRef.current = true;
    setDestinationPath(path);
  }, []);

  const handleOptionsChange = useCallback(
    (options: ExportOptions) => {
      void refreshDestination(options);
    },
    [refreshDestination],
  );

  const handlePickDestination = useCallback(
    async (options: ExportOptions) => {
      try {
        const filename = buildExportFilename(selectedFile, options);
        const pickedPath = await pickExportTarget(filename, destinationPath);
        if (pickedPath === null) return;
        destinationLockedRef.current = true;
        setDestinationPath(pickedPath);
      } catch {
        // The extension host already surfaces picker errors.
      }
    },
    [destinationPath, pickExportTarget, selectedFile],
  );

  const handleSaveBlob = useCallback(
    async (blob: Blob, filename: string) => {
      const savedPath = await saveBlob(blob, filename, destinationPath);
      if (savedPath) {
        destinationLockedRef.current = true;
        setDestinationPath(savedPath);
      }
    },
    [destinationPath, saveBlob],
  );

  const handleExport = useCallback(
    async (options: ExportOptions) => {
      setExporting(true);
      try {
        await runExport(markdownSource, selectedFile, options, mediaContainer, handleSaveBlob);
      } finally {
        setExporting(false);
        setDialogOpen(false);
      }
    },
    [handleSaveBlob, markdownSource, mediaContainer, selectedFile],
  );

  return (
    <>
      <button
        type="button"
        className="squisq-toolbar-button db-toolbar-export-trigger"
        onClick={handleOpenDialog}
        disabled={exporting}
        aria-label="Export document"
        data-tooltip={exporting ? 'Exporting...' : 'Export document'}
      >
        <ExportGlyph />
      </button>

      {dialogOpen && (
        <ExportDialog
          initial={dialogInitial}
          exporting={exporting}
          destination={{
            value: destinationPath,
            onChange: handleDestinationChange,
            onPick: handlePickDestination,
          }}
          onExport={handleExport}
          onOptionsChange={handleOptionsChange}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </>
  );
}

function ExportGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.5 1.75h4.25L12 5v7.25a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 3 12.25v-9a1.5 1.5 0 0 1 1.5-1.5z" />
      <path d="M8.75 1.75V5h3.25" />
      <path d="M6 8.75h4.5" />
      <path d="M8.75 7 10.5 8.75 8.75 10.5" />
    </svg>
  );
}
