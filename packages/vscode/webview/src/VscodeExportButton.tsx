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
import type { ExportTargetGrantMessage } from '../../src/messages.js';

export interface VscodeExportButtonProps {
  selectedFile: string | null;
  mediaContainer: ContentContainer | null;
  saveBlob: (
    blob: Blob,
    filename: string,
    target?: ExportTargetGrantMessage | null,
  ) => Promise<ExportTargetGrantMessage | null>;
  resolveExportTarget: (filename: string) => Promise<ExportTargetGrantMessage | null>;
  pickExportTarget: (
    filename: string,
    currentTarget?: ExportTargetGrantMessage | null,
  ) => Promise<ExportTargetGrantMessage | null>;
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
  const [destinationTarget, setDestinationTarget] = useState<ExportTargetGrantMessage | null>(null);
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
    async (options: ExportOptions) => {
      const requestId = destinationRequestRef.current + 1;
      destinationRequestRef.current = requestId;

      try {
        const filename = buildExportFilename(selectedFile, options);
        const target = await resolveExportTarget(filename);
        if (destinationRequestRef.current === requestId) {
          setDestinationTarget(target);
          setDestinationPath(target?.displayLabel ?? '');
        }
      } catch {
        if (destinationRequestRef.current === requestId) setDestinationPath('');
      }
    },
    [resolveExportTarget, selectedFile],
  );

  const handleOpenDialog = useCallback(() => {
    setDialogOpen(true);
    void refreshDestination(dialogInitial);
  }, [dialogInitial, refreshDestination]);

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
        const pickedTarget = await pickExportTarget(filename, destinationTarget);
        if (pickedTarget === null) return;
        setDestinationTarget(pickedTarget);
        setDestinationPath(pickedTarget.displayLabel);
      } catch {
        // The extension host already surfaces picker errors.
      }
    },
    [destinationTarget, pickExportTarget, selectedFile],
  );

  const handleSaveBlob = useCallback(
    async (blob: Blob, filename: string) => {
      const savedTarget = await saveBlob(blob, filename, destinationTarget);
      if (savedTarget) {
        setDestinationTarget(savedTarget);
        setDestinationPath(savedTarget.displayLabel);
      }
    },
    [destinationTarget, saveBlob],
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
            onPick: handlePickDestination,
            hint: 'VS Code owns and validates this destination.',
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
