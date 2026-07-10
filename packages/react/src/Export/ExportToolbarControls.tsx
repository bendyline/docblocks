/**
 * ExportToolbarControls — toolbar-right slot content.
 *
 * Renders a "..." overflow menu on the right side of the toolbar
 * containing export actions (document export + video export).
 *
 * Must be rendered inside <EditorProvider> so useEditorContext() works.
 */

import {
  lazy,
  Suspense,
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  type ComponentType,
} from 'react';
import { useEditorContext } from '@bendyline/squisq-editor-react';
import { getThemeSummaries } from '@bendyline/squisq/schemas';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import type { ContentContainer } from '@bendyline/squisq/storage';
import type { VideoExportModalProps } from '@bendyline/squisq-video-react';
import type { ExportOptions } from './export-options.js';
import {
  DEFAULT_OPTIONS,
  FORMAT_EXTENSIONS,
  loadLastExportOptions,
  saveExportOptions,
} from './export-options.js';
import type { ExportBlobSaver } from './run-export.js';
import { updateExportTargetExtension } from './export-destination.js';
import { loadTransformStyleSummaries, type ExportSummaryOption } from './transform-summaries.js';

const ExportDialog = lazy(() =>
  import('./ExportDialog.js').then((module) => ({ default: module.ExportDialog })),
);

let runExportModulePromise: Promise<typeof import('./run-export.js')> | null = null;

function loadRunExportModule(): Promise<typeof import('./run-export.js')> {
  runExportModulePromise ??= import('./run-export.js');
  return runExportModulePromise;
}

export interface ExportToolbarControlsProps {
  /** Currently selected file path — used to derive the download filename. */
  selectedFile: string | null;
  /** Media container for resolving images during export. */
  mediaContainer?: ContentContainer | null;
  /** Override the default browser download behavior for host-provided save flows. */
  saveBlob?: ExportBlobSaver;
  /** Optional host adapter for displaying, picking, and saving to a native target path. */
  destinationAdapter?: ExportDestinationAdapter;
  /** Render the trigger as a direct Export button instead of the overflow menu. */
  trigger?: 'menu' | 'button';
  /** Whether to show video export in the overflow menu. */
  showVideoExport?: boolean;
}

/** Host-specific operations behind the shared export destination control. */
export interface ExportDestinationAdapter {
  resolveTarget: (filename: string) => Promise<string>;
  pickTarget: (filename: string, currentPath?: string | null) => Promise<string | null>;
  saveBlob: (blob: Blob, filename: string, targetPath?: string | null) => Promise<string | null>;
  hint?: string;
}

type ParsedMarkdown = ReturnType<typeof parseMarkdown>;

interface VideoExportModules {
  Modal: ComponentType<VideoExportModalProps>;
  markdownToDoc: (doc: ParsedMarkdown) => VideoExportModalProps['doc'];
  playerScript: string;
}

let videoExportModulesPromise: Promise<VideoExportModules> | null = null;

function loadVideoExportModules(): Promise<VideoExportModules> {
  videoExportModulesPromise ??= Promise.all([
    import('@bendyline/squisq/doc'),
    import('@bendyline/squisq-video-react'),
    import('@bendyline/squisq-react/standalone-source'),
  ]).then(([docModule, videoModule, playerModule]) => ({
    Modal: videoModule.VideoExportModal,
    markdownToDoc: docModule.markdownToDoc,
    playerScript: playerModule.PLAYER_BUNDLE,
  }));
  return videoExportModulesPromise;
}

/** Build the quick-export label from saved options. */
function quickLabel(opts: ExportOptions, transformSummaries: ExportSummaryOption[]): string {
  const baseExt = FORMAT_EXTENSIONS[opts.format].toUpperCase().replace('.', '');
  // Recursive HTML always emits a ZIP (multi-doc tree), regardless of
  // the saved `htmlBundle` value. Applies to both plain and rendered
  // styles since both now ship recursive bundle helpers.
  const isRecursiveHtml = opts.format === 'html' && opts.includeLinkedDocs;
  const ext =
    opts.format === 'html' && (opts.htmlBundle === 'zip' || isRecursiveHtml) ? 'ZIP' : baseExt;
  const parts: string[] = [];

  if (opts.format === 'html' && opts.htmlStyle === 'rendered') {
    parts.push('rendered');
  }
  if (isRecursiveHtml) {
    parts.push('linked docs');
  }
  // Plain HTML also applies themes now (squisq's `markdownDocToPlainHtml`
  // emits theme-driven CSS), so include the theme name in the quick-
  // export label for every HTML style — not just rendered.
  if (opts.themeId !== 'standard') {
    const theme = getThemeSummaries().find((t) => t.id === opts.themeId);
    if (theme) parts.push(theme.name);
  }
  if (opts.format === 'pptx' && opts.transformStyle) {
    const transform = transformSummaries.find((t) => t.id === opts.transformStyle);
    if (transform) parts.push(transform.name);
  }

  if (parts.length > 0) {
    return `Export ${ext} with ${parts.join(' + ')}`;
  }
  return `Export ${ext}`;
}

export function ExportToolbarControls({
  selectedFile,
  mediaContainer,
  saveBlob,
  destinationAdapter,
  trigger = 'menu',
  showVideoExport = true,
}: ExportToolbarControlsProps) {
  const { markdownSource, markdownDoc } = useEditorContext();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoLoadError, setVideoLoadError] = useState<string | null>(null);
  const [videoModules, setVideoModules] = useState<VideoExportModules | null>(null);
  const [videoDoc, setVideoDoc] = useState<VideoExportModalProps['doc'] | null>(null);
  const [transformSummaries, setTransformSummaries] = useState<ExportSummaryOption[]>([]);
  const [exporting, setExporting] = useState(false);
  const [destinationPath, setDestinationPath] = useState('');
  const destinationLockedRef = useRef(false);
  const destinationRequestRef = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);

  const lastOptions = loadLastExportOptions();

  /** Doc's currently-set squisq theme, pulled from the markdown
   *  frontmatter. The Document Settings dialog and Theme Customizer
   *  write the theme under `squisq-theme` (canonical) or `theme`
   *  (legacy); some older docs persist it as `themeId`. We honor all
   *  three so an author who set their theme anywhere upstream sees it
   *  pre-selected in the export dialog. */
  const docThemeId = useMemo(() => {
    const fm = markdownDoc?.frontmatter as Record<string, unknown> | undefined;
    if (!fm) return null;
    const candidates = [fm['squisq-theme'], fm['theme'], fm['themeId']];
    for (const v of candidates) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  }, [markdownDoc]);

  /** Options used to populate the export dialog. Layered: built-in
   *  defaults → user's last-chosen export options (if any) → doc's
   *  current frontmatter theme (wins). The frontmatter override
   *  guarantees that "set theme in the editor, then export" pre-selects
   *  the right theme instead of resurrecting whatever the user picked
   *  for some unrelated previous doc. */
  const dialogInitial = useMemo(() => {
    const base = lastOptions ?? DEFAULT_OPTIONS;
    return docThemeId ? { ...base, themeId: docThemeId } : base;
  }, [lastOptions, docThemeId]);

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

  useEffect(() => {
    if (
      !menuOpen ||
      lastOptions?.format !== 'pptx' ||
      !lastOptions.transformStyle ||
      transformSummaries.length > 0
    ) {
      return;
    }

    let cancelled = false;
    loadTransformStyleSummaries()
      .then((nextSummaries) => {
        if (!cancelled) setTransformSummaries(nextSummaries);
      })
      .catch(() => {
        if (!cancelled) setTransformSummaries([]);
      });

    return () => {
      cancelled = true;
    };
  }, [lastOptions?.format, lastOptions?.transformStyle, menuOpen, transformSummaries.length]);

  const handleToggleMenu = useCallback(() => {
    setMenuOpen((prev) => !prev);
  }, []);

  const refreshDestination = useCallback(
    async (options: ExportOptions, force = false) => {
      if (!destinationAdapter) return;

      const requestId = destinationRequestRef.current + 1;
      destinationRequestRef.current = requestId;

      try {
        const { buildExportFilename } = await loadRunExportModule();
        const filename = buildExportFilename(selectedFile, options);
        if (!force && destinationLockedRef.current) {
          setDestinationPath((current) => updateExportTargetExtension(current, filename));
          return;
        }
        const target = await destinationAdapter.resolveTarget(filename);
        if (destinationRequestRef.current === requestId) setDestinationPath(target);
      } catch {
        if (destinationRequestRef.current === requestId) setDestinationPath('');
      }
    },
    [destinationAdapter, selectedFile],
  );

  const handleOpenDialog = useCallback(() => {
    setMenuOpen(false);
    destinationLockedRef.current = false;
    setDialogOpen(true);
    void refreshDestination(dialogInitial, true);
  }, [dialogInitial, refreshDestination]);

  const handleCloseDialog = useCallback(() => {
    setDialogOpen(false);
  }, []);

  const handleOpenVideoModal = useCallback(async () => {
    setMenuOpen(false);
    setVideoModalOpen(true);
    setVideoLoading(true);
    setVideoLoadError(null);

    try {
      const modules = videoModules ?? (await loadVideoExportModules());
      setVideoModules(modules);
      setVideoDoc(modules.markdownToDoc(parseMarkdown(markdownSource)));
    } catch {
      setVideoLoadError('Video export could not be loaded.');
    } finally {
      setVideoLoading(false);
    }
  }, [markdownSource, videoModules]);

  const handleCloseVideoModal = useCallback(() => {
    setVideoModalOpen(false);
    setVideoDoc(null);
    setVideoLoadError(null);
  }, []);

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
      if (!destinationAdapter) return;
      try {
        const { buildExportFilename } = await loadRunExportModule();
        const filename = buildExportFilename(selectedFile, options);
        const pickedPath = await destinationAdapter.pickTarget(filename, destinationPath);
        if (pickedPath === null) return;
        destinationLockedRef.current = true;
        setDestinationPath(pickedPath);
      } catch {
        // Native hosts surface picker failures through their own UI channel.
      }
    },
    [destinationAdapter, destinationPath, selectedFile],
  );

  const saveToDestination = useCallback(
    async (blob: Blob, filename: string, targetPath: string | null) => {
      if (!destinationAdapter) return;
      const savedPath = await destinationAdapter.saveBlob(blob, filename, targetPath);
      if (savedPath) {
        destinationLockedRef.current = true;
        setDestinationPath(savedPath);
      }
    },
    [destinationAdapter],
  );

  const handleDestinationSaveBlob = useCallback(
    async (blob: Blob, filename: string) => {
      await saveToDestination(blob, filename, destinationPath || null);
    },
    [destinationPath, saveToDestination],
  );

  const handleExport = useCallback(
    async (opts: ExportOptions) => {
      setExporting(true);
      try {
        const { runExport } = await loadRunExportModule();
        await runExport(
          markdownSource,
          selectedFile,
          opts,
          mediaContainer,
          destinationAdapter ? handleDestinationSaveBlob : saveBlob,
        );
      } finally {
        setExporting(false);
        setDialogOpen(false);
      }
    },
    [
      markdownSource,
      selectedFile,
      mediaContainer,
      destinationAdapter,
      handleDestinationSaveBlob,
      saveBlob,
    ],
  );

  const handleQuickExport = useCallback(async () => {
    if (!lastOptions) return;
    setMenuOpen(false);
    setExporting(true);
    try {
      saveExportOptions(lastOptions);
      const { runExport } = await loadRunExportModule();
      let quickTarget: string | null = null;
      if (destinationAdapter) {
        const { buildExportFilename } = await loadRunExportModule();
        quickTarget = await destinationAdapter.resolveTarget(
          buildExportFilename(selectedFile, lastOptions),
        );
      }
      await runExport(
        markdownSource,
        selectedFile,
        lastOptions,
        mediaContainer,
        destinationAdapter
          ? async (blob, filename) => saveToDestination(blob, filename, quickTarget)
          : saveBlob,
      );
    } finally {
      setExporting(false);
    }
  }, [
    destinationAdapter,
    lastOptions,
    markdownSource,
    mediaContainer,
    saveBlob,
    saveToDestination,
    selectedFile,
  ]);

  const LoadedVideoExportModal = videoModules?.Modal;

  return (
    <>
      {trigger === 'button' ? (
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
      ) : (
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
                  {quickLabel(lastOptions, transformSummaries)}
                </button>
              )}
              <button className="db-toolbar-menu-item" onClick={handleOpenDialog}>
                Export...
              </button>
              {showVideoExport && (
                <>
                  <div className="db-toolbar-menu-divider" />
                  <button className="db-toolbar-menu-item" onClick={handleOpenVideoModal}>
                    Export Video...
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {dialogOpen && (
        <Suspense fallback={null}>
          <ExportDialog
            initial={dialogInitial}
            exporting={exporting}
            destination={
              destinationAdapter
                ? {
                    value: destinationPath,
                    onChange: handleDestinationChange,
                    onPick: handlePickDestination,
                    hint: destinationAdapter.hint,
                  }
                : undefined
            }
            onExport={handleExport}
            onOptionsChange={destinationAdapter ? handleOptionsChange : undefined}
            onClose={handleCloseDialog}
          />
        </Suspense>
      )}

      {videoModalOpen && (videoLoading || videoLoadError) && (
        <div className="db-dialog-overlay">
          <div className="db-dialog">
            <div className="db-dialog-header">
              <h2 className="db-dialog-title">Export Video</h2>
              <button
                className="db-dialog-close"
                onClick={handleCloseVideoModal}
                aria-label="Close"
              >
                &times;
              </button>
            </div>
            <div className="db-dialog-body">
              <p className="db-export-hint">{videoLoadError ?? 'Loading...'}</p>
            </div>
          </div>
        </div>
      )}

      {videoModalOpen &&
        videoModules &&
        LoadedVideoExportModal &&
        videoDoc &&
        !videoLoading &&
        !videoLoadError && (
          <LoadedVideoExportModal
            doc={videoDoc}
            playerScript={videoModules.playerScript}
            onClose={handleCloseVideoModal}
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
