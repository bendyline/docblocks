/**
 * ExportToolbarControls — toolbar-right slot content.
 *
 * Renders an export/share menu on the right side of the toolbar containing
 * document export, sharing, and video export actions.
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
import { useEditorContext, usePreviewSettings } from '@bendyline/squisq-editor-react';
import type { SharedDocumentMode } from '@bendyline/docblocks/share';
import { getThemeSummaries } from '@bendyline/squisq/schemas';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import type { ContentContainer } from '@bendyline/squisq/storage';
import type { DisplayMode } from '@bendyline/squisq-react';
import type { FfmpegWasmLoadConfig } from '@bendyline/squisq-video';
import type { VideoExportModalProps } from '@bendyline/squisq-video-react';
import type { ExportOptions } from './export-options.js';
import {
  DEFAULT_OPTIONS,
  FORMAT_EXTENSIONS,
  loadLastExportOptions,
  saveExportOptions,
} from './export-options.js';
import type { ExportBlobSaver } from './run-export.js';
import { loadTransformStyleSummaries, type ExportSummaryOption } from './transform-summaries.js';
import { Dialog } from '../components/Dialog.js';
import { useMenuKeyboard } from '../components/useMenuKeyboard.js';

const ExportDialog = lazy(() =>
  import('./ExportDialog.js').then((module) => ({ default: module.ExportDialog })),
);
const ShareDialog = lazy(() =>
  import('./ShareDialog.js').then((module) => ({ default: module.ShareDialog })),
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
  /** Self-hosted ffmpeg.wasm core. Supplying it enables Animated GIF export. */
  ffmpegWasm?: FfmpegWasmLoadConfig;
  /** Resolved host color scheme for the video export dialog. */
  colorScheme?: 'light' | 'dark';
  /** Host palette overrides for the video export dialog and progress UI. */
  videoExportPalette?: VideoExportModalProps['uiPalette'];
  /** HTTP(S) DocBlocks page used as the base of generated shared links. */
  shareBaseUrl?: string;
  /** One-time Use mode supplied by an opened shared document link. */
  initialSharedMode?: SharedDocumentMode | null;
}

/** Host-specific operations behind the shared export destination control. */
export interface ExportDestinationTarget {
  grantId: string | null;
  displayPath: string;
}

export interface ExportDestinationAdapter {
  resolveTarget: (filename: string) => Promise<ExportDestinationTarget>;
  pickTarget: (
    filename: string,
    currentTarget?: ExportDestinationTarget | null,
  ) => Promise<ExportDestinationTarget | null>;
  saveBlob: (
    blob: Blob,
    filename: string,
    target?: ExportDestinationTarget | null,
  ) => Promise<ExportDestinationTarget | null>;
  hint?: string;
}

interface ResolvedQuickDestination {
  key: string;
  target: ExportDestinationTarget;
}

class ExportCancelledError extends Error {}

type ParsedMarkdown = ReturnType<typeof parseMarkdown>;

interface VideoExportModules {
  Modal: ComponentType<VideoExportModalProps>;
  markdownToDoc: (doc: ParsedMarkdown) => VideoExportModalProps['doc'];
  playerScript: string;
}

const SHARED_USE_MODES: Readonly<Record<SharedDocumentMode, DisplayMode>> = Object.freeze({
  slideshow: 'slideshow',
  video: 'video',
  page: 'linear',
  document: 'page',
  narrate: 'narrate',
});

function SharedModeInitializer({ mode }: { mode: SharedDocumentMode }) {
  const appliedRef = useRef(false);
  const { setActiveView } = useEditorContext();
  const { setSelectedDisplayMode } = usePreviewSettings();

  useEffect(() => {
    if (appliedRef.current) return;
    appliedRef.current = true;
    setSelectedDisplayMode(SHARED_USE_MODES[mode]);
    setActiveView('preview');
  }, [mode, setActiveView, setSelectedDisplayMode]);

  return null;
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

/**
 * Turn whatever `runExport` rejected with into something a user can act on.
 * The pipeline throws real `Error`s (unreadable image, converter failure,
 * destination write refused) whose messages are already user-facing.
 */
function exportErrorMessage(caught: unknown): string {
  const detail =
    caught instanceof Error
      ? caught.message.replace(/^Error invoking remote method '[^']+': Error:\s*/, '').trim()
      : '';
  return detail ? `Export failed: ${detail}` : 'Export failed. The document could not be exported.';
}

/** Build the quick-export label from saved options. */
function quickLabel(
  opts: ExportOptions,
  transformSummaries: ExportSummaryOption[],
  destinationPath?: string,
): string {
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
    const label = `Export ${ext} with ${parts.join(' + ')}`;
    return destinationPath ? `${label} to ${destinationPath}` : label;
  }
  const label = `Export ${ext}`;
  return destinationPath ? `${label} to ${destinationPath}` : label;
}

export function ExportToolbarControls({
  selectedFile,
  mediaContainer,
  saveBlob,
  destinationAdapter,
  trigger = 'menu',
  showVideoExport = true,
  ffmpegWasm,
  colorScheme = 'light',
  videoExportPalette,
  shareBaseUrl,
  initialSharedMode = null,
}: ExportToolbarControlsProps) {
  const { markdownSource, markdownDoc } = useEditorContext();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const [videoOutputFormat, setVideoOutputFormat] = useState<'mp4' | 'gif'>('mp4');
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoLoadError, setVideoLoadError] = useState<string | null>(null);
  const [videoModules, setVideoModules] = useState<VideoExportModules | null>(null);
  const [videoDoc, setVideoDoc] = useState<VideoExportModalProps['doc'] | null>(null);
  const [transformSummaries, setTransformSummaries] = useState<ExportSummaryOption[]>([]);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [destinationTarget, setDestinationTarget] = useState<ExportDestinationTarget | null>(null);
  const [quickDestination, setQuickDestination] = useState<ResolvedQuickDestination | null>(null);
  const [quickDestinationPending, setQuickDestinationPending] = useState(false);
  const destinationRequestRef = useRef(0);
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const { menuRef, triggerRef, handleMenuKeyDown, handleTriggerKeyDown, closeMenu } =
    useMenuKeyboard(menuOpen, setMenuOpen);

  const lastOptions = loadLastExportOptions();
  const quickDestinationKey = lastOptions ? JSON.stringify([selectedFile, lastOptions]) : null;
  const quickDestinationTarget =
    quickDestination?.key === quickDestinationKey ? quickDestination.target : null;

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
      if (menuContainerRef.current && !menuContainerRef.current.contains(e.target as Node)) {
        closeMenu(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [closeMenu, menuOpen]);

  useEffect(() => {
    if (menuOpen) return;
    setQuickDestination(null);
    setQuickDestinationPending(false);
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

  useEffect(() => {
    if (!menuOpen || !destinationAdapter || !quickDestinationKey) return;

    const quickOptions = loadLastExportOptions();
    if (!quickOptions) return;

    let cancelled = false;
    setQuickDestination(null);
    setQuickDestinationPending(true);
    void loadRunExportModule()
      .then(({ buildExportFilename }) =>
        destinationAdapter.resolveTarget(buildExportFilename(selectedFile, quickOptions)),
      )
      .then((target) => {
        if (!cancelled) setQuickDestination({ key: quickDestinationKey, target });
      })
      .catch(() => {
        if (!cancelled) setQuickDestination(null);
      })
      .finally(() => {
        if (!cancelled) setQuickDestinationPending(false);
      });

    return () => {
      cancelled = true;
    };
  }, [destinationAdapter, menuOpen, quickDestinationKey, selectedFile]);

  const handleToggleMenu = useCallback(() => {
    if (!menuOpen && destinationAdapter) {
      setQuickDestination(null);
      setQuickDestinationPending(true);
    }
    setMenuOpen((prev) => !prev);
  }, [destinationAdapter, menuOpen]);

  const refreshDestination = useCallback(
    async (options: ExportOptions) => {
      if (!destinationAdapter) return;

      const requestId = destinationRequestRef.current + 1;
      destinationRequestRef.current = requestId;

      try {
        const { buildExportFilename } = await loadRunExportModule();
        const filename = buildExportFilename(selectedFile, options);
        const target = await destinationAdapter.resolveTarget(filename);
        if (destinationRequestRef.current === requestId) setDestinationTarget(target);
      } catch {
        if (destinationRequestRef.current === requestId) setDestinationTarget(null);
      }
    },
    [destinationAdapter, selectedFile],
  );

  const handleOpenDialog = useCallback(() => {
    setMenuOpen(false);
    setExportError(null);
    setDialogOpen(true);
    void refreshDestination(dialogInitial);
  }, [dialogInitial, refreshDestination]);

  const handleCloseDialog = useCallback(() => {
    setDialogOpen(false);
    setExportError(null);
  }, []);

  const handleOpenShareDialog = useCallback(() => {
    setMenuOpen(false);
    setShareDialogOpen(true);
  }, []);

  const handleCloseShareDialog = useCallback(() => {
    setShareDialogOpen(false);
  }, []);

  const handleOpenVideoModal = useCallback(
    async (outputFormat: 'mp4' | 'gif') => {
      setMenuOpen(false);
      setVideoOutputFormat(outputFormat);
      setVideoModalOpen(true);
      setVideoLoadError(null);

      if (outputFormat === 'gif' && typeof SharedArrayBuffer === 'undefined') {
        setVideoLoading(false);
        setVideoLoadError(
          'Animated GIF export needs cross-origin isolation. If this app just finished ' +
            'installing for offline use, reload it once and try again.',
        );
        return;
      }

      setVideoLoading(true);

      try {
        const modules = videoModules ?? (await loadVideoExportModules());
        setVideoModules(modules);
        setVideoDoc(modules.markdownToDoc(parseMarkdown(markdownSource)));
      } catch {
        setVideoLoadError('Video export could not be loaded.');
      } finally {
        setVideoLoading(false);
      }
    },
    [markdownSource, videoModules],
  );

  const handleCloseVideoModal = useCallback(() => {
    setVideoModalOpen(false);
    setVideoDoc(null);
    setVideoLoadError(null);
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
        const pickedTarget = await destinationAdapter.pickTarget(filename, destinationTarget);
        if (pickedTarget === null) return;
        setDestinationTarget(pickedTarget);
        setQuickDestination(null);
      } catch {
        // Native hosts surface picker failures through their own UI channel.
      }
    },
    [destinationAdapter, destinationTarget, selectedFile],
  );

  const saveToDestination = useCallback(
    async (blob: Blob, filename: string, target: ExportDestinationTarget | null) => {
      if (!destinationAdapter) return;
      const savedTarget = await destinationAdapter.saveBlob(blob, filename, target);
      if (!savedTarget) throw new ExportCancelledError();
      setDestinationTarget(savedTarget);
    },
    [destinationAdapter],
  );

  const handleDestinationSaveBlob = useCallback(
    async (blob: Blob, filename: string) => {
      await saveToDestination(blob, filename, destinationTarget);
    },
    [destinationTarget, saveToDestination],
  );

  const handleExport = useCallback(
    async (opts: ExportOptions) => {
      setExporting(true);
      setExportError(null);
      try {
        const { runExport } = await loadRunExportModule();
        await runExport(
          markdownSource,
          selectedFile,
          opts,
          mediaContainer,
          destinationAdapter ? handleDestinationSaveBlob : saveBlob,
        );
        // Only a completed export dismisses the dialog. Closing in a
        // `finally` used to make a failure look exactly like a success.
        setDialogOpen(false);
      } catch (caught: unknown) {
        if (!(caught instanceof ExportCancelledError)) setExportError(exportErrorMessage(caught));
      } finally {
        setExporting(false);
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
    setExportError(null);
    try {
      saveExportOptions(lastOptions);
      const { runExport } = await loadRunExportModule();
      let quickTarget: ExportDestinationTarget | null = null;
      if (destinationAdapter) {
        if (!quickDestinationTarget) return;
        quickTarget = quickDestinationTarget;
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
    } catch (caught: unknown) {
      // No dialog is open on this path, so the failure gets its own —
      // same shape as the video-export load failure below.
      if (!(caught instanceof ExportCancelledError)) setExportError(exportErrorMessage(caught));
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
    quickDestinationTarget,
  ]);

  const handleDismissExportError = useCallback(() => {
    setExportError(null);
  }, []);

  const LoadedVideoExportModal = videoModules?.Modal;
  const showAnimatedGifExport =
    showVideoExport && typeof ffmpegWasm?.coreURL === 'string' && ffmpegWasm.coreURL.length > 0;

  return (
    <>
      {initialSharedMode && <SharedModeInitializer mode={initialSharedMode} />}
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
        <div className="db-toolbar-menu" ref={menuContainerRef}>
          <button
            ref={triggerRef}
            type="button"
            className="db-toolbar-menu-trigger"
            onClick={handleToggleMenu}
            onKeyDown={handleTriggerKeyDown}
            aria-label="Export and share"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="Export and share"
          >
            <ShareGlyph />
            <span className="db-toolbar-menu-trigger-label">Export</span>
          </button>

          {menuOpen && (
            <div
              ref={menuRef}
              className="db-toolbar-menu-dropdown db-export-toolbar-menu-dropdown"
              role="menu"
              onKeyDown={handleMenuKeyDown}
            >
              {lastOptions && (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="db-toolbar-menu-item"
                  onClick={handleQuickExport}
                  disabled={exporting || (Boolean(destinationAdapter) && !quickDestinationTarget)}
                  title={
                    quickDestinationTarget
                      ? quickLabel(
                          lastOptions,
                          transformSummaries,
                          quickDestinationTarget.displayPath,
                        )
                      : undefined
                  }
                >
                  {quickDestinationTarget
                    ? quickLabel(
                        lastOptions,
                        transformSummaries,
                        quickDestinationTarget.displayPath,
                      )
                    : quickLabel(lastOptions, transformSummaries) +
                      (destinationAdapter
                        ? quickDestinationPending
                          ? ' (finding destination...)'
                          : ' (destination unavailable)'
                        : '')}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="db-toolbar-menu-item"
                onClick={handleOpenDialog}
              >
                Export...
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="db-toolbar-menu-item"
                onClick={handleOpenShareDialog}
              >
                Share link with content embedded...
              </button>
              {showVideoExport && (
                <>
                  <div className="db-toolbar-menu-divider" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className="db-toolbar-menu-item"
                    onClick={() => void handleOpenVideoModal('mp4')}
                  >
                    Export video...
                  </button>
                  {showAnimatedGifExport && (
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className="db-toolbar-menu-item"
                      onClick={() => void handleOpenVideoModal('gif')}
                    >
                      Export animated gif...
                    </button>
                  )}
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
            error={exportError}
            destination={
              destinationAdapter
                ? {
                    value: destinationTarget?.displayPath ?? '',
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

      {/* Quick export fails with no dialog open — give the failure its own,
          mirroring the video-export load-failure surface below. */}
      {exportError && !dialogOpen && (
        <Dialog
          title="Export Document"
          onClose={handleDismissExportError}
          footer={
            <button
              type="button"
              className="db-export-btn db-export-btn--secondary"
              onClick={handleDismissExportError}
            >
              Close
            </button>
          }
        >
          <p className="db-export-error" role="alert">
            {exportError}
          </p>
        </Dialog>
      )}

      {shareDialogOpen && (
        <Suspense fallback={null}>
          <ShareDialog
            markdown={markdownSource}
            selectedFile={selectedFile}
            baseUrl={
              shareBaseUrl ??
              (typeof window === 'undefined'
                ? 'https://bendyline.github.io/docblocks/'
                : window.location.href)
            }
            onClose={handleCloseShareDialog}
          />
        </Suspense>
      )}

      {videoModalOpen && (videoLoading || videoLoadError) && (
        <Dialog
          title={videoOutputFormat === 'gif' ? 'Export Animated GIF' : 'Export Video'}
          onClose={handleCloseVideoModal}
        >
          <p className="db-export-hint" role={videoLoadError ? 'alert' : undefined}>
            {videoLoadError ?? 'Loading...'}
          </p>
        </Dialog>
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
            colorScheme={colorScheme}
            uiPalette={videoExportPalette}
            defaultConfig={{
              audioPolicy: 'best-effort',
              ...(ffmpegWasm ? { ffmpegWasm } : {}),
              outputFormat: videoOutputFormat,
            }}
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

function ShareGlyph() {
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
      <path d="M8 10.5V1.75" />
      <path d="M5.25 4.5 8 1.75l2.75 2.75" />
      <path d="M4.25 6.75h-1a1.5 1.5 0 0 0-1.5 1.5v4.5a1.5 1.5 0 0 0 1.5 1.5h9.5a1.5 1.5 0 0 0 1.5-1.5v-4.5a1.5 1.5 0 0 0-1.5-1.5h-1" />
    </svg>
  );
}
