import { useCallback, useMemo, useRef, useState } from 'react';
import { useEditorContext } from '@bendyline/squisq-editor-react/shell';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { docToPptx } from '@bendyline/squisq-formats/pptx';
import {
  DEFAULT_OPTIONS,
  ExportDialog,
  buildExportFilename,
  loadLastExportOptions,
  runExport,
  updateExportTargetExtension,
  type ExportOptions,
} from '@bendyline/docblocks-react/export';
import type { ExportTargetGrantMessage } from '@bendyline/docblocks/vscode';
import { validateExportDestinationEdit } from './exportDestinationEdit.js';

export interface VscodeExportButtonProps {
  selectedFile: string | null;
  mediaContainer: ContentContainer | null;
  saveBlob: (
    blob: Blob,
    filename: string,
    target?: ExportTargetGrantMessage | null,
    targetFilename?: string | null,
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
  const [exportError, setExportError] = useState<string | null>(null);
  const [destinationPath, setDestinationPath] = useState('');
  const [destinationError, setDestinationError] = useState<string | null>(null);
  const destinationRequestRef = useRef(0);
  const destinationPathRef = useRef('');
  const destinationEditedRef = useRef(false);
  const destinationTargetRef = useRef<ExportTargetGrantMessage | null>(null);

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
          destinationTargetRef.current = target;
          destinationPathRef.current = target?.displayLabel ?? filename;
          setDestinationPath(destinationPathRef.current);
          setDestinationError(null);
          destinationEditedRef.current = false;
        }
      } catch {
        if (destinationRequestRef.current === requestId) {
          destinationTargetRef.current = null;
          destinationPathRef.current = '';
          setDestinationPath('');
          setDestinationError('The export destination could not be resolved.');
          destinationEditedRef.current = false;
        }
      }
    },
    [resolveExportTarget, selectedFile],
  );

  const handleOpenDialog = useCallback(() => {
    const filename = buildExportFilename(selectedFile, dialogInitial);
    setExportError(null);
    setDestinationError(null);
    destinationTargetRef.current = null;
    destinationPathRef.current = filename;
    setDestinationPath(filename);
    destinationEditedRef.current = false;
    setDialogOpen(true);
    void refreshDestination(dialogInitial);
  }, [dialogInitial, refreshDestination, selectedFile]);

  const handleCloseDialog = useCallback(() => {
    destinationRequestRef.current += 1;
    setDialogOpen(false);
    setExportError(null);
    setDestinationError(null);
  }, []);

  const handleOptionsChange = useCallback(
    (options: ExportOptions) => {
      if (destinationEditedRef.current) {
        const filename = buildExportFilename(selectedFile, options);
        const nextPath = updateExportTargetExtension(destinationPathRef.current, filename);
        destinationPathRef.current = nextPath;
        setDestinationPath(nextPath);
        setDestinationError(
          validateExportDestinationEdit(
            nextPath,
            destinationTargetRef.current?.displayLabel ?? null,
            filename,
          ).error,
        );
        return;
      }
      void refreshDestination(options);
    },
    [refreshDestination, selectedFile],
  );

  const handleDestinationChange = useCallback(
    (value: string, options: ExportOptions) => {
      destinationRequestRef.current += 1;
      const filename = buildExportFilename(selectedFile, options);
      setExportError(null);
      destinationPathRef.current = value;
      setDestinationPath(value);
      destinationEditedRef.current = true;
      setDestinationError(
        validateExportDestinationEdit(
          value,
          destinationTargetRef.current?.displayLabel ?? null,
          filename,
        ).error,
      );
    },
    [selectedFile],
  );

  const handlePickDestination = useCallback(
    async (options: ExportOptions) => {
      try {
        const suggestedFilename = buildExportFilename(selectedFile, options);
        const edited = validateExportDestinationEdit(
          destinationPathRef.current,
          destinationTargetRef.current?.displayLabel ?? null,
          suggestedFilename,
        );
        const filename = edited.filename ?? suggestedFilename;
        const pickedTarget = await pickExportTarget(filename, destinationTargetRef.current);
        if (pickedTarget === null) return;
        destinationTargetRef.current = pickedTarget;
        destinationPathRef.current = pickedTarget.displayLabel;
        setDestinationPath(pickedTarget.displayLabel);
        setDestinationError(null);
        destinationEditedRef.current = false;
      } catch {
        // The extension host already surfaces picker errors.
      }
    },
    [pickExportTarget, selectedFile],
  );

  const handleSaveBlob = useCallback(
    async (blob: Blob, filename: string) => {
      const edited = validateExportDestinationEdit(
        destinationPathRef.current,
        destinationTargetRef.current?.displayLabel ?? null,
        filename,
      );
      if (edited.error || !edited.filename) {
        throw new Error(edited.error ?? 'The export filename is invalid.');
      }
      const targetFilename =
        destinationEditedRef.current &&
        destinationPathRef.current !== destinationTargetRef.current?.displayLabel
          ? edited.filename
          : null;
      const savedTarget = await saveBlob(
        blob,
        filename,
        destinationTargetRef.current,
        targetFilename,
      );
      if (savedTarget) {
        destinationTargetRef.current = savedTarget;
        destinationPathRef.current = savedTarget.displayLabel;
        setDestinationPath(savedTarget.displayLabel);
        setDestinationError(null);
        destinationEditedRef.current = false;
      }
    },
    [saveBlob],
  );

  const handleExport = useCallback(
    async (options: ExportOptions) => {
      setExporting(true);
      setExportError(null);
      try {
        // VS Code webviews can outlive an extension rebuild or update. Loading
        // the PPTX converter with this control keeps a visible Export button
        // from later requesting a hashed chunk that has already been replaced.
        await runExport(markdownSource, selectedFile, options, mediaContainer, handleSaveBlob, {
          docToPptx,
        });
        setDialogOpen(false);
      } catch (caught: unknown) {
        setExportError(exportErrorMessage(caught));
      } finally {
        setExporting(false);
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
          error={exportError}
          destination={{
            value: destinationPath,
            onChange: handleDestinationChange,
            onPick: handlePickDestination,
            error: destinationError,
          }}
          onExport={handleExport}
          onOptionsChange={handleOptionsChange}
          onClose={handleCloseDialog}
        />
      )}
    </>
  );
}

function exportErrorMessage(caught: unknown): string {
  const detail = caught instanceof Error ? caught.message.trim() : '';
  return detail ? `Export failed: ${detail}` : 'Export failed. The document could not be exported.';
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
