/**
 * DocBlocksShell -- top-level layout component.
 *
 * Composes the left sidebar (WorkspacePicker + FileExplorer) with
 * the center editor area (squisq EditorShell).
 */

import { useState, useCallback, useEffect, useRef, useMemo, lazy, Suspense } from 'react';
import type {
  EditorColorScheme,
  EditorView,
  ViewPreferences,
} from '@bendyline/squisq-editor-react';
import type { MediaProvider } from '@bendyline/squisq/schemas';
import type { FfmpegWasmLoadConfig } from '@bendyline/squisq-video';
import type { VideoExportPalette } from '@bendyline/squisq-video-react';
import {
  DocumentVersionManager,
  type PrunePolicy,
  type SaveVersionResult,
} from '@bendyline/squisq/versions';
import type {
  DbkWorkspaceSnapshot,
  ElectronFileSystemProvider,
  FileSystemProvider,
  FileSystemEntry,
  MemoryFileSystemProvider,
} from '@bendyline/docblocks/filesystem';
import {
  FileSystemContentContainer,
  createFileMediaProvider,
  decodeUtf8Text,
  FsError,
  getFileSystemProviderV2,
  isQuotaExceededError,
  moveFileSystemEntry,
  parseWorkspacePath,
  workspacePathContains,
} from '@bendyline/docblocks/filesystem';
import {
  createFileSystemDocumentTarget,
  DocumentCommitConflictError,
  DocumentSessionConflictError,
  type DocumentCommitTarget,
  type DocumentSessionEditScope,
} from '@bendyline/docblocks/document';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { isElectronHost, getDocBlocksHost } from '@bendyline/docblocks/host';
import type { ElectronWorkspaceInfo, OpenRequest } from '@bendyline/docblocks/host';
import {
  parseSharedDocumentHash,
  type SharedDocumentMode,
  type SharedDocumentPayload,
} from '@bendyline/docblocks/share';
import type { WorkspaceDescriptor } from '@bendyline/docblocks/workspace';
import {
  ensureDefaultWorkspace,
  getWorkspace,
  listWorkspaces,
  reconcileElectronWorkspaceDescriptors,
  removeWorkspace,
  saveWorkspace,
  touchWorkspace,
  registerTransientWorkspace,
  getTransientWorkspace,
  unregisterTransientWorkspace,
} from '@bendyline/docblocks/workspace';
import { AppMenu } from '../AppMenu/AppMenu.js';
import { pickEmptyDocumentPrompt, useResponsivePreviewViewportPreset } from '../editor.js';
import {
  FileExplorer,
  type FileTreeChange,
  type FileTreeMutationHandler,
} from '../FileExplorer/FileExplorer.js';
import { WorkspacePicker } from '../WorkspacePicker/WorkspacePicker.js';
import { WorkspaceSettingsButton } from '../WorkspacePicker/WorkspaceSettingsButton.js';
import { SplitViewIcon } from '../icons.js';
import {
  WorkspaceSettingsDialog,
  type WorkspaceVersioningOverride,
} from '../WorkspacePicker/WorkspaceSettingsDialog.js';
import { useDocumentSession } from '../hooks/useDocumentSession.js';
import {
  ExportToolbarControls,
  type ExportDestinationAdapter,
} from '../Export/DeferredExportToolbarControls.js';
import { GitContext } from '../Git/GitContext.js';
import { useGit } from '../Git/useGit.js';
// The editor is only needed after a document and its media container are
// ready. Workspace chrome stays interactive while this large feature loads.
let editorShellModulePromise: Promise<typeof import('./LazyEditorShell.js')> | null = null;

function loadEditorShell(): Promise<typeof import('./LazyEditorShell.js')> {
  editorShellModulePromise ??= (async () => {
    const workersReady = (globalThis as { docBlocksMonacoWorkersReady?: Promise<unknown> })
      .docBlocksMonacoWorkersReady;
    const editorReady = import('./LazyEditorShell.js');
    // Worker setup is an enhancement; a host that cannot install language
    // workers must not make the document editor unavailable. Start the editor
    // request at the same time so worker wiring never serializes the large
    // editor chunk behind its own host-facing bootstrap.
    const [editorModule] = await Promise.all([editorReady, workersReady?.catch(() => undefined)]);
    return editorModule;
  })();
  return editorShellModulePromise;
}

const EditorShell = lazy(loadEditorShell);
// The git dialogs/status bar only ever render under the Electron host, so
// they load as a split chunk -- the site never pays for them (the entry
// bundle budget is enforced by scripts/check-bundle-size.ts).
const GitUI = lazy(() => import('../Git/GitUI.js').then((m) => ({ default: m.GitUI })));
const GitToolbarControl = lazy(() =>
  import('../Git/GitToolbarControl.js').then((m) => ({ default: m.GitToolbarControl })),
);
import {
  loadVersioningPreference,
  resolveVersioningEnabled,
  saveVersioningPreference,
  type VersioningPreference,
} from '../preferences/versioning.js';
import {
  DB_CHROME_COLORS,
  loadAccentColor,
  loadThemePreference,
  saveAccentColor,
  saveThemePreference,
  type AccentColor,
  type ThemePreference,
} from '../preferences/theme.js';
import {
  loadWriteCanvasPreferences,
  saveWriteCanvasPreferences,
  type WriteCanvasPreferences,
} from '../preferences/write-canvas.js';
import { retainFileSystemProvider } from '../provider-lease.js';
import { useDocumentTitle } from './document-title.js';
import { decodeDbkWorkspace } from './dbk-import.js';
import { resolveShellEditorLinkTarget } from './editor-link-navigation.js';
import { importDroppedFiles, summariseImport } from './import-files.js';
import { providerEntryExists, removeProviderEntry, writeProviderText } from './provider-io.js';
import { usePromptDialog } from '../components/usePromptDialog.js';
import { useConfirmDialog } from '../components/useConfirmDialog.js';
import { resolveShellTheme } from './resolve-theme.js';
import { buildIssueReportUrl } from './issue-report.js';
import { loadLastState, saveLastState } from './last-state.js';
import {
  isWelcomeGatewayDismissed,
  loadSidebarWidth,
  loadViewPreferences,
  markWelcomeGatewayDismissed,
  saveSidebarWidth,
  saveViewPreferences,
  SIDEBAR_COLLAPSE_THRESHOLD,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from './shell-preferences.js';
import { UpdateAvailableNotice } from './UpdateAvailableNotice.js';
import { useDocumentLinkProvider } from './useDocumentLinkProvider.js';
import { WorkspaceAuthorityBarrier } from './workspace-authority-barrier.js';
import { copyTransientWorkspaceContents } from './transient-workspace-move.js';
import { WELCOME_DOCUMENT_CONTENT, WELCOME_DOCUMENT_PATH } from './welcome-document.js';
import {
  loadPinnedDocuments,
  missingPinnedDocumentMessage,
  movePinnedDocumentsToWorkspace,
  pinnedDocumentKey,
  relocatePinnedDocuments,
  removePinnedDocument,
  renamePinnedDocumentWorkspace,
  savePinnedDocuments,
  togglePinnedDocument,
  type PinnedDocument,
  type PinnedDocumentAvailability,
  type PinnedDocumentListItem,
} from './pinned-documents.js';

const DOCBLOCKS_VIDEO_EXPORT_PALETTE: Partial<VideoExportPalette> = Object.freeze({
  overlay: 'rgba(0, 0, 0, 0.72)',
  surface: 'var(--db-bg)',
  control: 'var(--db-bg-subtle)',
  border: 'var(--db-border-strong)',
  text: 'var(--db-text)',
  heading: 'var(--db-text)',
  label: 'var(--db-text-secondary)',
  muted: 'var(--db-text-muted)',
  secondary: 'var(--db-accent-tint-strong)',
  primary: 'var(--db-accent)',
  primaryBorder: 'var(--db-accent-hover)',
  primaryText: 'var(--db-text-on-accent)',
  success: 'var(--db-git-added)',
  danger: 'var(--db-danger)',
});

let indexedDbFileSystemModule: Promise<
  typeof import('@bendyline/docblocks/filesystem/indexeddb')
> | null = null;
let memoryFileSystemModule: Promise<
  typeof import('@bendyline/docblocks/filesystem/memory')
> | null = null;
let nativeFileSystemModule: Promise<
  typeof import('@bendyline/docblocks/filesystem/native')
> | null = null;
let electronFileSystemModule: Promise<
  typeof import('@bendyline/docblocks/filesystem/electron')
> | null = null;

function loadIndexedDbFileSystem() {
  indexedDbFileSystemModule ??= import('@bendyline/docblocks/filesystem/indexeddb').catch(
    (error: unknown) => {
      indexedDbFileSystemModule = null;
      throw error;
    },
  );
  return indexedDbFileSystemModule;
}

function loadMemoryFileSystem() {
  memoryFileSystemModule ??= import('@bendyline/docblocks/filesystem/memory').catch(
    (error: unknown) => {
      memoryFileSystemModule = null;
      throw error;
    },
  );
  return memoryFileSystemModule;
}

function loadNativeFileSystem() {
  nativeFileSystemModule ??= import('@bendyline/docblocks/filesystem/native').catch(
    (error: unknown) => {
      nativeFileSystemModule = null;
      throw error;
    },
  );
  return nativeFileSystemModule;
}

function loadElectronFileSystem() {
  electronFileSystemModule ??= import('@bendyline/docblocks/filesystem/electron').catch(
    (error: unknown) => {
      electronFileSystemModule = null;
      throw error;
    },
  );
  return electronFileSystemModule;
}

async function createIndexedDbFileSystemProvider(id: string, label: string) {
  const { IndexedDBFileSystemProvider } = await loadIndexedDbFileSystem();
  return new IndexedDBFileSystemProvider(id, label);
}

async function createElectronFileSystemProvider(
  id: string,
  label: string,
  rootPath: string,
): Promise<ElectronFileSystemProvider> {
  const { ElectronFileSystemProvider } = await loadElectronFileSystem();
  return new ElectronFileSystemProvider(id, label, rootPath);
}

async function createMemoryFileSystemProvider(
  id: string,
  label: string,
): Promise<MemoryFileSystemProvider> {
  const { MemoryFileSystemProvider } = await loadMemoryFileSystem();
  return new MemoryFileSystemProvider(id, label);
}

function isMemoryWorkspaceProvider(
  provider: FileSystemProvider,
): provider is MemoryFileSystemProvider {
  const candidate = provider as Partial<MemoryFileSystemProvider>;
  return (
    typeof candidate.captureContents === 'function' &&
    typeof candidate.replaceContents === 'function' &&
    typeof candidate.treeVersion === 'number'
  );
}

export interface DocBlocksShellProps {
  /**
   * The theme to use before the user has an opinion. Omit or pass `'auto'` to
   * follow the OS. An explicit `'light'`/`'dark'` choice the user makes in
   * Settings outranks this — it is their app, not the host's.
   */
  theme?: EditorColorScheme | 'auto';
  /** Optional logo image URL for the app menu. */
  logoUrl?: string;
  /** Version and surface label included in prefilled issue reports, e.g. `1.1.2 web`. */
  issueReportVersion?: string;
  /** ISO build date shown in About, e.g. `2026-07-15`. */
  appBuildDate?: string;
  /** Self-hosted ffmpeg.wasm core. Supplying it enables Animated GIF export. */
  ffmpegWasm?: FfmpegWasmLoadConfig;
  /** Stable host title used before a document opens and for the optional home document. */
  homeDocumentTitle?: string;
  /** Document path that represents the host's indexable home experience. */
  homeDocumentPath?: string;
  /**
   * Enable document version history. Snapshots are written under
   * `<basename>_files/.versions/` next to each markdown file (i.e., the
   * per-document container). Defaults to `true`.
   */
  allowVersioning?: boolean;
  /**
   * Override the document basename used in version filenames. Defaults
   * to the basename of the currently selected file.
   */
  versionBasename?: string;
  /** Prune policy applied after each successful save. Default: keep last 50. */
  versioningPrunePolicy?: PrunePolicy;
  /** Idle delay (ms) before the editor auto-saves a version. `0` disables. Default 5000. */
  versioningAutoSaveIdleMs?: number;
  /** Notified after each `saveVersion` attempt (saved=true and saved=false). */
  onSaveVersion?: (result: SaveVersionResult) => void;
  /** Optional escape hatch for hosts that want imperative access to the version manager. */
  versioningRef?: React.Ref<DocumentVersionManager | null>;
  /**
   * True when a new deploy is waiting (browser PWA hosts: a fresh service
   * worker finished installing). The shell shows an "Update available"
   * status-bar notice; clicking it opens a nearby Reload/Later prompt.
   */
  updateAvailable?: boolean;
  /** Activates the waiting update and reloads onto the new version. */
  onApplyUpdate?: () => void;
  /** Host-supplied content rendered at the right edge of the editor status bar. */
  statusBarSlotRight?: React.ReactNode;
  /**
   * True once the app has been fully cached for offline use (browser PWA
   * hosts). Shown to the user once as a passive notice.
   */
  offlineReady?: boolean;
}

function useOsTheme(): 'light' | 'dark' {
  const [dark, setDark] = useState(
    () =>
      typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return dark ? 'dark' : 'light';
}

/** Encode workspace + optional file path into a URL hash. */
function buildHash(workspaceId: string, filePath?: string | null): string {
  const ws = encodeURIComponent(workspaceId);
  if (!filePath) return `#${ws}`;
  const fp = filePath.replace(/^\//, '');
  return `#${ws}/${encodeURIComponent(fp)}`;
}

/** Decode the current URL hash into workspace id + file path. */
function parseHash(): { workspaceId: string; filePath: string | null } | null {
  const raw = window.location.hash.slice(1);
  if (!raw) return null;
  try {
    const slashIdx = raw.indexOf('/');
    if (slashIdx === -1) {
      return { workspaceId: decodeURIComponent(raw), filePath: null };
    }
    return {
      workspaceId: decodeURIComponent(raw.slice(0, slashIdx)),
      filePath: '/' + decodeURIComponent(raw.slice(slashIdx + 1)),
    };
  } catch {
    return null;
  }
}

function dirnameOf(p: string): string {
  const clean = p.replace(/^\/+/, '');
  const idx = clean.lastIndexOf('/');
  return idx === -1 ? '' : clean.slice(0, idx);
}

function basenameOf(p: string): string {
  const clean = p.replace(/^\/+/, '');
  const idx = clean.lastIndexOf('/');
  return idx === -1 ? clean : clean.slice(idx + 1);
}

/** Strip the extension from a filename (`notes.md` -> `notes`). Matches
 *  squisq's `getDocBasename` convention so version snapshot filenames
 *  stay readable (`<basename>.<timestamp>.md`). */
function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function normaliseProviderPath(p: string): string {
  const canonical = parseWorkspacePath(p);
  return canonical ? `/${canonical}` : '/';
}

function sameProviderPath(a: string, b: string): boolean {
  return normaliseProviderPath(a) === normaliseProviderPath(b);
}

function relocateProviderPath(path: string, oldPath: string, newPath: string): string {
  const current = normaliseProviderPath(path);
  const oldNormalised = normaliseProviderPath(oldPath);
  if (current !== oldNormalised && !current.startsWith(`${oldNormalised}/`)) return path;
  return `${newPath.replace(/\/+$/, '')}${current.slice(oldNormalised.length)}`;
}

function pathContains(parentPath: string, candidatePath: string): boolean {
  return workspacePathContains(parseWorkspacePath(parentPath), parseWorkspacePath(candidatePath));
}

async function readProviderDirectory(
  provider: FileSystemProvider,
  path: string,
): Promise<FileSystemEntry[]> {
  const providerV2 = getFileSystemProviderV2(provider);
  if (!providerV2) return provider.readDirectory(path);
  const entries = await providerV2.readDirectory(parseWorkspacePath(path));
  return entries.map((entry) => ({ kind: entry.kind, name: entry.name, path: entry.path }));
}

async function readProviderText(
  provider: FileSystemProvider,
  path: string,
): Promise<string | null> {
  const providerV2 = getFileSystemProviderV2(provider);
  if (!providerV2) return provider.readFile(path);
  const file = await providerV2.readFile(parseWorkspacePath(path));
  return file
    ? decodeUtf8Text(file.data, { label: 'The document', path: parseWorkspacePath(path) })
    : null;
}

async function pinnedProviderFileExists(
  provider: FileSystemProvider,
  path: string,
): Promise<boolean> {
  const providerV2 = getFileSystemProviderV2(provider);
  if (!providerV2) return provider.exists(path);
  const entry = await providerV2.stat(parseWorkspacePath(path));
  if (!entry) return false;
  if (entry.kind !== 'file') throw new Error('The pinned path is no longer a document.');
  return true;
}

/** Delete one pinned file with the strongest conditional semantics offered by its provider. */
async function removePinnedProviderFile(
  provider: FileSystemProvider,
  path: string,
): Promise<boolean> {
  const providerV2 = getFileSystemProviderV2(provider);
  if (providerV2) {
    const canonical = parseWorkspacePath(path);
    const entry = await providerV2.stat(canonical);
    if (!entry) return false;
    if (entry.kind !== 'file') throw new Error('The pinned path is no longer a document.');
    await providerV2.remove(canonical, {
      recursive: false,
      missing: 'error',
      expectedVersion: entry.version,
    });
    return true;
  }
  if (!(await provider.exists(path))) return false;
  await provider.delete(path);
  return true;
}

async function readStableFileSnapshot(
  provider: FileSystemProvider,
  path: string,
): Promise<{ content: string | null; version: string | null }> {
  const providerV2 = getFileSystemProviderV2(provider);
  if (providerV2) {
    const read = await providerV2.readFile(parseWorkspacePath(path));
    return {
      content: read
        ? decodeUtf8Text(read.data, {
            label: 'The document',
            path: parseWorkspacePath(path),
          })
        : null,
      version: read?.entry.version ?? null,
    };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await provider.stat(path);
    const content = await provider.readFile(path);
    const after = await provider.stat(path);
    const unchanged = before?.lastModified === after?.lastModified && before?.size === after?.size;
    const existenceMatches = (content !== null) === (after !== null);
    if (unchanged && existenceMatches) {
      return {
        content,
        version: after ? `${after.lastModified}:${after.size}` : null,
      };
    }
  }
  throw new Error('The file kept changing while DocBlocks was reading it.');
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Ask for write access to a file handle delivered by the web File Handling
 * API. Chromium grants read on launch; readwrite needs one prompt, ideally
 * requested while the OS-launch user activation is still fresh. The
 * permission methods are Chromium-only extensions (same inline typing
 * approach as core's native-provider), so absent methods are treated as
 * writable and the write itself surfaces any failure.
 */
async function ensureHandleWritePermission(handle: FileSystemFileHandle): Promise<boolean> {
  const h = handle as FileSystemFileHandle & {
    queryPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
    requestPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  };
  if (!h.queryPermission || !h.requestPermission) return true;
  try {
    const opts = { mode: 'readwrite' as const };
    if ((await h.queryPermission(opts)) === 'granted') return true;
    return (await h.requestPermission(opts)) === 'granted';
  } catch {
    return false;
  }
}

/** Portable relative link from one workspace file to another. Walks up
 *  from the source's directory and back down to the target so the link
 *  survives folder reshuffles (`../sibling.md`, `subfolder/child.md`,
 *  `resume.md` for siblings at the workspace root). */
/**
 * Walk a FileSystemProvider and copy every file into a content container.
 * Kept outside the component so document commit targets and backup actions
 * share one implementation.
 */
async function copyProviderToContainer(
  src: FileSystemProvider,
  container: { writeFile: (path: string, data: ArrayBuffer | Uint8Array) => Promise<void> },
  pathPrefix: string,
): Promise<void> {
  const providerV2 = getFileSystemProviderV2(src);
  if (providerV2) {
    const snapshot = await providerV2.snapshot();
    for (const entry of snapshot.entries) {
      if (entry.kind !== 'file') continue;
      const rel = entry.path;
      const destination = pathPrefix ? `${pathPrefix}/${rel}` : rel;
      await container.writeFile(destination, entry.data);
    }
    return;
  }

  const stack: string[] = ['/'];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await readProviderDirectory(src, dir);
    for (const entry of entries) {
      if (entry.kind === 'directory') {
        stack.push(entry.path);
        continue;
      }
      const rel = entry.path.replace(/^\/+/, '');
      const zipPath = pathPrefix ? pathPrefix + '/' + rel : rel;
      const binary = await src.readBinary(entry.path);
      if (binary) await container.writeFile(zipPath, binary);
      else {
        const text = await src.readFile(entry.path);
        if (text === null) throw new Error(`The workspace changed while reading ${entry.path}.`);
        await container.writeFile(zipPath, new TextEncoder().encode(text));
      }
    }
  }
}

interface PendingDbkConflict {
  provider: MemoryFileSystemProvider;
  snapshot: DbkWorkspaceSnapshot;
}

type PinnedDocumentProviderAccess =
  | { kind: 'missing-workspace' }
  | { kind: 'unavailable'; workspace: WorkspaceDescriptor }
  | {
      kind: 'ready';
      workspace: WorkspaceDescriptor;
      provider: FileSystemProvider;
      owned: boolean;
    };

async function createElectronProviderFromWorkspace(
  ws: WorkspaceDescriptor,
): Promise<ElectronFileSystemProvider | null> {
  if (!ws.rootPath) return null;
  try {
    await getDocBlocksHost().workspaces.register(ws.id);
  } catch {
    return null;
  }
  return createElectronFileSystemProvider(ws.id, ws.name, ws.rootPath);
}

function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(
    () =>
      typeof window !== 'undefined' && window.matchMedia(`(max-width: ${breakpoint}px)`).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [breakpoint]);
  return isMobile;
}

function FolderGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z" />
    </svg>
  );
}

function FileGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

export function DocBlocksShell({
  theme: hostTheme = 'auto',
  logoUrl,
  issueReportVersion,
  appBuildDate,
  ffmpegWasm,
  homeDocumentTitle,
  homeDocumentPath,
  allowVersioning = true,
  versionBasename,
  versioningPrunePolicy,
  versioningAutoSaveIdleMs,
  onSaveVersion,
  versioningRef,
  updateAvailable = false,
  onApplyUpdate,
  statusBarSlotRight,
  offlineReady = false,
}: DocBlocksShellProps) {
  const osTheme = useOsTheme();
  const [themePreference, setThemePreference] = useState<ThemePreference>(loadThemePreference);
  const [accentColor, setAccentColor] = useState<AccentColor>(loadAccentColor);
  const [writeCanvasSettings, setWriteCanvasSettings] = useState<WriteCanvasPreferences>(
    loadWriteCanvasPreferences,
  );
  // Settings choice > the host's `theme` prop > the OS. See resolve-theme.ts
  // for why that order. Stamped as `data-theme` on the shell root below.
  const resolvedTheme = resolveShellTheme({ preference: themePreference, hostTheme, osTheme });

  const handleThemeChange = useCallback((pref: ThemePreference) => {
    setThemePreference(pref);
    saveThemePreference(pref);
  }, []);

  // Keep the browser's theme-color metas in sync with the resolved theme so
  // the installed web app's titlebar (Window Controls Overlay caption area,
  // Android status bar) matches the shell chrome. Both media-attributed
  // metas are overwritten on purpose: an explicit user theme choice must
  // beat the OS media query. Electron paints its own titlebar.
  useEffect(() => {
    if (isElectronHost() || typeof document === 'undefined') return;
    const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    metas.forEach((meta) => {
      meta.content = DB_CHROME_COLORS[resolvedTheme];
    });
  }, [resolvedTheme]);

  const handleAccentColorChange = useCallback((color: AccentColor) => {
    setAccentColor(color);
    saveAccentColor(color);
  }, []);

  const handleWriteCanvasSettingsChange = useCallback((settings: WriteCanvasPreferences) => {
    setWriteCanvasSettings(settings);
    saveWriteCanvasPreferences(settings);
  }, []);

  const [viewPreferences, setViewPreferences] = useState<ViewPreferences>(loadViewPreferences);
  const handleViewPreferencesChange = useCallback((prefs: ViewPreferences) => {
    setViewPreferences(prefs);
    saveViewPreferences(prefs);
  }, []);
  const isMobile = useIsMobile();
  const defaultPreviewViewportPreset = useResponsivePreviewViewportPreset();
  // Keep a true first visit in the compact file pane so the product can
  // explain itself before opening a document. Once the one-time welcome has
  // been acknowledged, returning mobile users go straight back to the editor.
  const [mobileShowEditor, setMobileShowEditor] = useState(
    () => isMobile && isWelcomeGatewayDismissed(),
  );
  useEffect(() => {
    if (isMobile) void loadEditorShell();
  }, [isMobile]);
  // Sidebar width -- persisted across sessions, dragged via the resizer
  // between sidebar and editor area. We track the "live" width during a
  // drag in a ref so each mousemove doesn't trigger a state update; only
  // setState on commit so React doesn't churn through every pixel.
  const [sidebarWidth, setSidebarWidth] = useState<number>(loadSidebarWidth);
  // When the user drags the resizer below SIDEBAR_COLLAPSE_THRESHOLD,
  // we switch the layout into single-pane "compact" mode -- same UX as
  // the mobile narrow-viewport flow, where only the sidebar OR the
  // editor is visible at a time and a back-arrow in the toolbar pops
  // between them. A "Restore split view" button in either pane's header
  // exits compact mode; on real mobile that button is suppressed
  // because there's not enough viewport for side-by-side. Not
  // persisted across reloads. */
  const [compactLayout, setCompactLayout] = useState(false);
  const effectiveCompact = isMobile || compactLayout;
  const showBrowserStorageWarning = !isElectronHost();
  const appVersion = isElectronHost()
    ? `${getDocBlocksHost().env.appVersion} desktop`
    : (issueReportVersion ?? 'web');
  const issueReportUrl = buildIssueReportUrl({
    reportedAt: new Date(),
    version: appVersion,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
  });
  const [browserStoragePersistent, setBrowserStoragePersistent] = useState(false);

  // --- The shell's three notification channels -------------------------
  // Declared up here because the popstate handler below is the earliest
  // consumer; everything that talks to the user goes through one of these
  // rather than through window.alert/confirm/prompt, which block the
  // renderer, ignore the theme, and wear the browser's name.

  // Ctrl/Cmd+S is a real acknowledgement of the session revision, not an
  // optimistic toast. A failed commit remains dirty and is surfaced.
  const [saveToast, setSaveToast] = useState<{
    kind: 'success' | 'error';
    message: string;
  } | null>(null);
  const saveToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The shell's one transient-notification channel. Everything that needs to
   * tell the user "that worked" / "that didn't" routes through here so the
   * self-dismiss timers cannot fight each other.
   */
  const showToast = useCallback((kind: 'success' | 'error', message: string) => {
    setSaveToast({ kind, message });
    if (saveToastTimerRef.current) clearTimeout(saveToastTimerRef.current);
    saveToastTimerRef.current = setTimeout(() => setSaveToast(null), 3000);
  }, []);

  // The shell's stand-in for `window.prompt()`, which Electron's renderer does
  // not implement -- calling it there throws and the action dies silently.
  const { prompt: promptForText, promptDialog } = usePromptDialog();

  // Stand-ins for `window.confirm()` (a question) and `window.alert()` (a
  // message worth stopping for). Transient outcomes use showToast instead.
  const { confirm: confirmAction, acknowledge, confirmDialog } = useConfirmDialog();

  // The file tree asks before deleting; give it this shell's dialog so the
  // prompt matches the product rather than falling back to its native one.
  const confirmDeleteEntry = useCallback(
    (message: string) =>
      confirmAction({
        title: 'Delete',
        message,
        confirmLabel: 'Delete',
        destructive: true,
      }),
    [confirmAction],
  );

  // Browser PWA install prompt (Chromium only). The event is stashed when
  // the browser deems the app installable and spent on first use.
  const [installPromptEvent, setInstallPromptEvent] = useState<BeforeInstallPromptEvent | null>(
    null,
  );
  const sidebarRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const handleResizerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      dragStateRef.current = { startX: e.clientX, startWidth: sidebarWidth };
      e.preventDefault();
      // Disable text selection + flip the body cursor for the duration
      // of the drag so the col-resize cursor stays visible even when the
      // pointer slips off the 7px hit area. The custom cursor lives in
      // the CSS class so Windows' white-cursor preference doesn't make
      // the dragging cursor invisible against the light chrome.
      document.body.style.userSelect = 'none';
      document.body.classList.add('db-resizing-sidebar');
      let lastRaw = sidebarWidth;
      const onMove = (ev: PointerEvent) => {
        const drag = dragStateRef.current;
        if (!drag) return;
        lastRaw = drag.startWidth + (ev.clientX - drag.startX);
        if (lastRaw < SIDEBAR_COLLAPSE_THRESHOLD && sidebarRef.current) {
          // Below threshold -- preview the collapse by snapping to the
          // minimum width and fading the sidebar, so the user can see
          // they've crossed into "release to collapse" territory.
          sidebarRef.current.style.width = `${SIDEBAR_WIDTH_MIN}px`;
          sidebarRef.current.style.opacity = '0.45';
          return;
        }
        const clamped = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, lastRaw));
        if (sidebarRef.current) {
          // Update the DOM directly during the drag for jank-free
          // dragging; React state syncs on release.
          sidebarRef.current.style.width = `${clamped}px`;
          sidebarRef.current.style.opacity = '';
        }
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.body.style.userSelect = '';
        document.body.classList.remove('db-resizing-sidebar');
        if (sidebarRef.current) {
          sidebarRef.current.style.opacity = '';
        }
        if (lastRaw < SIDEBAR_COLLAPSE_THRESHOLD) {
          // Released below threshold -- switch to compact (single-pane)
          // layout focused on the document pane. Keep the persisted
          // sidebarWidth so exiting compact mode restores it.
          setCompactLayout(true);
          setMobileShowEditor(true);
        } else {
          const finalWidth = sidebarRef.current?.getBoundingClientRect().width;
          if (finalWidth) {
            const clamped = Math.min(
              SIDEBAR_WIDTH_MAX,
              Math.max(SIDEBAR_WIDTH_MIN, Math.round(finalWidth)),
            );
            setSidebarWidth(clamped);
            saveSidebarWidth(clamped);
          }
        }
        dragStateRef.current = null;
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    },
    [sidebarWidth],
  );
  const [provider, setProvider] = useState<FileSystemProvider | null>(null);
  const [workspaceStartupError, setWorkspaceStartupError] = useState<string | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [activeWorkspaceDescriptor, setActiveWorkspaceDescriptor] =
    useState<WorkspaceDescriptor | null>(null);
  useEffect(() => {
    if (!provider || getTransientWorkspace(provider.id)) return;
    const providerV2 = getFileSystemProviderV2(provider);
    return providerV2 ? retainFileSystemProvider(providerV2) : undefined;
  }, [provider]);
  // Re-fetch the descriptor whenever the active id (or its versioning
  // override) changes. `descriptorRefreshKey` is bumped after writes so
  // the resolver picks up the updated override without remounting.
  const [descriptorRefreshKey, setDescriptorRefreshKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    if (!activeWorkspaceId) {
      setActiveWorkspaceDescriptor(null);
      return;
    }
    void getWorkspace(activeWorkspaceId).then((ws) => {
      if (!cancelled) setActiveWorkspaceDescriptor(ws);
    });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, descriptorRefreshKey]);
  const [pinnedDocuments, setPinnedDocuments] = useState<PinnedDocument[]>(loadPinnedDocuments);
  const [pinnedDocumentAvailability, setPinnedDocumentAvailability] = useState<
    ReadonlyMap<string, PinnedDocumentAvailability>
  >(() => new Map());
  useEffect(() => {
    savePinnedDocuments(pinnedDocuments);
  }, [pinnedDocuments]);
  // Mirror the pinned list into the desktop tray so each document gets a
  // one-click shortcut. No-op on non-Electron surfaces.
  useEffect(() => {
    if (!isElectronHost()) return;
    getDocBlocksHost().menu.setPinnedDocuments(
      pinnedDocuments.map((document) => ({
        workspaceId: document.workspaceId,
        workspaceName: document.workspaceName,
        path: document.path,
      })),
    );
  }, [pinnedDocuments]);
  const setPinnedAvailability = useCallback(
    (
      document: Pick<PinnedDocument, 'workspaceId' | 'path'>,
      availability: PinnedDocumentAvailability,
    ) => {
      const key = pinnedDocumentKey(document);
      setPinnedDocumentAvailability((current) => {
        if (current.get(key) === availability) return current;
        const next = new Map(current);
        next.set(key, availability);
        return next;
      });
    },
    [],
  );
  const pinnedDocumentItems = useMemo<PinnedDocumentListItem[]>(
    () =>
      pinnedDocuments.map((document) => ({
        ...document,
        availability: pinnedDocumentAvailability.get(pinnedDocumentKey(document)) ?? 'unknown',
      })),
    [pinnedDocumentAvailability, pinnedDocuments],
  );
  useEffect(() => {
    if (!provider || !activeWorkspaceId) return;
    const activePins = pinnedDocuments.filter(
      (document) => document.workspaceId === activeWorkspaceId,
    );
    if (activePins.length === 0) return;

    let cancelled = false;
    let scanning = false;
    let scanAgain = false;
    const scan = async (): Promise<void> => {
      if (scanning) {
        scanAgain = true;
        return;
      }
      scanning = true;
      try {
        do {
          scanAgain = false;
          await Promise.all(
            activePins.map(async (document) => {
              try {
                const exists = await providerEntryExists(provider, document.path);
                if (!cancelled) setPinnedAvailability(document, exists ? 'available' : 'missing');
              } catch {
                // Permission, quota, corruption, and I/O errors are not
                // absence. Leave a deliberately non-committal annotation.
                if (!cancelled) setPinnedAvailability(document, 'unknown');
              }
            }),
          );
        } while (scanAgain && !cancelled);
      } finally {
        scanning = false;
      }
    };

    void scan();
    const scanOnFocus = () => void scan();
    window.addEventListener('focus', scanOnFocus);

    const providerV2 = getFileSystemProviderV2(provider);
    const subscription = providerV2?.capabilities.watch
      ? providerV2.watch(
          (event) => {
            if (event.type !== 'modified') void scan();
          },
          { onError: () => undefined },
        )
      : null;
    void subscription?.ready.catch(() => undefined);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', scanOnFocus);
      void subscription?.dispose();
    };
  }, [activeWorkspaceId, pinnedDocuments, provider, setPinnedAvailability]);
  const [transientMoveDestinations, setTransientMoveDestinations] = useState<WorkspaceDescriptor[]>(
    [],
  );
  useEffect(() => {
    if (activeWorkspaceDescriptor?.type !== 'transient') {
      setTransientMoveDestinations([]);
      return;
    }
    let cancelled = false;
    const electron = isElectronHost();
    void listWorkspaces()
      .then((workspaces) => {
        if (cancelled) return;
        setTransientMoveDestinations(
          workspaces.filter(
            (workspace) =>
              workspace.type !== 'transient' &&
              (electron
                ? workspace.type === 'electron-native'
                : workspace.type !== 'electron-native'),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setTransientMoveDestinations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceDescriptor]);

  // All git UI state/actions -- null-renders on surfaces without git.
  const gitWorkspaceId =
    provider &&
    activeWorkspaceDescriptor?.id === activeWorkspaceId &&
    provider.id === activeWorkspaceId &&
    activeWorkspaceDescriptor.type === 'electron-native'
      ? activeWorkspaceDescriptor.id
      : null;
  const git = useGit(provider, gitWorkspaceId, resolvedTheme);
  const gitRef = useRef(git);
  gitRef.current = git;
  const { scheduleRefresh: gitScheduleRefresh } = git;

  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
  const [versioningPreference, setVersioningPreference] =
    useState<VersioningPreference>(loadVersioningPreference);
  const handleVersioningPreferenceChange = useCallback((pref: VersioningPreference) => {
    setVersioningPreference(pref);
    saveVersioningPreference(pref);
  }, []);
  const effectiveVersioning =
    allowVersioning && resolveVersioningEnabled(activeWorkspaceDescriptor, versioningPreference);

  const handleOpenWorkspaceSettings = useCallback(() => {
    if (!activeWorkspaceDescriptor) return;
    setWorkspaceSettingsOpen(true);
  }, [activeWorkspaceDescriptor]);

  const handleWorkspaceVersioningOverrideChange = useCallback(
    async (override: WorkspaceVersioningOverride) => {
      if (!activeWorkspaceDescriptor) return;
      await saveWorkspace({ ...activeWorkspaceDescriptor, versioningOverride: override });
      setDescriptorRefreshKey((k) => k + 1);
      setWorkspaceSettingsOpen(false);
    },
    [activeWorkspaceDescriptor],
  );
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  useDocumentTitle(selectedFile, homeDocumentTitle, homeDocumentPath);
  const exportDestinationAdapter = useMemo<ExportDestinationAdapter | undefined>(() => {
    if (!isElectronHost() || !activeWorkspaceId || !selectedFile) return undefined;
    const documentId = JSON.stringify([activeWorkspaceId, selectedFile]);
    const host = getDocBlocksHost().exports;
    return {
      resolveTarget: (filename) => host.resolveTarget(documentId, filename),
      pickTarget: (filename, currentTarget) =>
        host.pickTarget(documentId, filename, currentTarget?.grantId ?? null),
      saveBlob: async (blob, filename, target) =>
        host.save(documentId, filename, target?.grantId ?? null, await blob.arrayBuffer()),
    };
  }, [activeWorkspaceId, selectedFile]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [folderEntries, setFolderEntries] = useState<FileSystemEntry[]>([]);
  const { session: documentSession, snapshot: documentSnapshot } = useDocumentSession(500);
  // The session snapshot is the sole owner of document content and edit
  // identity. React retains only presentation state (path/folder/view).
  const editorContent = documentSnapshot.content;
  const editorSessionScope = useMemo<DocumentSessionEditScope | null>(
    () =>
      documentSnapshot.targetKey && !documentSnapshot.frozen
        ? {
            targetKey: documentSnapshot.targetKey,
            generation: documentSnapshot.generation,
          }
        : null,
    [documentSnapshot.frozen, documentSnapshot.generation, documentSnapshot.targetKey],
  );
  const [editorPresentationEpoch, setEditorPresentationEpoch] = useState(0);
  const editorKey = `${documentSnapshot.generation}:${editorPresentationEpoch}`;
  const editorPlaceholder = useMemo(() => {
    // Keep the selection scoped to the same generation that remounts Squisq.
    void editorKey;
    return pickEmptyDocumentPrompt();
  }, [editorKey]);
  const [explorerKey, setExplorerKey] = useState(0);
  const [documentLinkEpoch, setDocumentLinkEpoch] = useState(0);
  const [initialView, setInitialView] = useState<EditorView>('wysiwyg');
  const [initialSharedMode, setInitialSharedMode] = useState<SharedDocumentMode | null>(null);
  // First-run gateway over the welcome document's Play view.
  const [showWelcomeGateway, setShowWelcomeGateway] = useState(false);
  const navigationRequestRef = useRef(0);
  const workspaceAuthorityBarrier = useMemo(() => new WorkspaceAuthorityBarrier(), []);
  const preparedCloseRequestRef = useRef<string | null>(null);
  const pendingDbkConflictsRef = useRef(new Map<string, PendingDbkConflict>());

  const createDocumentTarget = useCallback(
    (
      fsProvider: FileSystemProvider,
      workspaceId: string,
      filePath: string,
    ): DocumentCommitTarget => {
      const transient = getTransientWorkspace(workspaceId);
      const baseTarget = createFileSystemDocumentTarget(fsProvider, filePath);

      const originKind = transient?.descriptor.origin?.kind;
      const needsElectronHost = originKind === 'loose-file' || originKind === 'dbk';
      if (!transient?.descriptor.origin || (needsElectronHost && !isElectronHost())) {
        return {
          key: baseTarget.key,
          async commit(request) {
            const result = await baseTarget.commit(request);
            gitScheduleRefresh();
            return result;
          },
        };
      }

      const origin = transient.descriptor.origin;

      if (origin.kind === 'web-file' || origin.kind === 'web-dbk') {
        // Launched-file origins (installed web app, File Handling API):
        // read and write through the FileSystemFileHandle instead of the
        // Electron host bridge, with the same optimistic external-change
        // detection as the host-backed paths below.
        const webOrigin = origin;
        const transientProvider = transient.provider;
        return {
          key: baseTarget.key,
          async commit(request) {
            if (!(await ensureHandleWritePermission(webOrigin.handle))) {
              throw new Error(
                `DocBlocks needs permission to write to "${webOrigin.name}". Save again to grant it.`,
              );
            }
            if (webOrigin.kind === 'web-file') {
              const current = await (await webOrigin.handle.getFile()).text();
              if (
                request.persistedContent !== null &&
                current !== request.persistedContent &&
                current !== request.content
              ) {
                pendingDbkConflictsRef.current.delete(baseTarget.key);
                await writeProviderText(fsProvider, filePath, current);
                throw new DocumentCommitConflictError(
                  'The original file changed outside DocBlocks.',
                  current,
                  null,
                );
              }
              const writable = await webOrigin.handle.createWritable();
              await writable.write(request.content);
              await writable.close();
              await baseTarget.commit(request);
              pendingDbkConflictsRef.current.delete(baseTarget.key);
              gitScheduleRefresh();
              return {};
            }
            // web-dbk: package the in-memory workspace into a zip and write
            // it back through the handle, guarded by a SHA-256
            // compare-and-swap that mirrors the Electron dbk path.
            const [{ MemoryContentContainer }, { containerToZip }] = await Promise.all([
              import('@bendyline/squisq/storage'),
              import('@bendyline/squisq-formats/container'),
            ]);
            const currentBytes = await (await webOrigin.handle.getFile()).arrayBuffer();
            const currentVersion = await sha256Hex(currentBytes);
            if (webOrigin.version !== null && currentVersion !== webOrigin.version) {
              if (!isMemoryWorkspaceProvider(transientProvider)) {
                throw new Error('A transient DBK workspace must use in-memory storage.');
              }
              const snapshot = await decodeDbkWorkspace(currentBytes, {
                targetDocumentPath: filePath,
              });
              // Keep both branches intact until the user chooses -- same
              // semantics as the Electron dbk conflict staging below.
              pendingDbkConflictsRef.current.set(baseTarget.key, {
                provider: transientProvider,
                snapshot,
              });
              webOrigin.version = currentVersion;
              throw new DocumentCommitConflictError(
                'The original DocBlocks bundle changed outside DocBlocks.',
                snapshot.documentContent,
                currentVersion,
              );
            }
            const container = new MemoryContentContainer();
            await copyProviderToContainer(transientProvider, container, '');
            await container.writeFile(
              filePath.replace(/^\/+/, ''),
              new TextEncoder().encode(request.content),
            );
            const blob = await containerToZip(container);
            const bytes = await blob.arrayBuffer();
            const writable = await webOrigin.handle.createWritable();
            await writable.write(bytes);
            await writable.close();
            webOrigin.version = await sha256Hex(bytes);
            // The transient provider intentionally retained the complete
            // local branch while external bundle B was staged for conflict
            // resolution. Once bundle C is committed to the origin, advance
            // that internal markdown baseline unconditionally; comparing its
            // old A content against request.persistedContent B would report a
            // false second conflict after the durable write already succeeded.
            await writeProviderText(fsProvider, filePath, request.content);
            pendingDbkConflictsRef.current.delete(baseTarget.key);
            gitScheduleRefresh();
            return { version: webOrigin.version };
          },
        };
      }

      return {
        key: baseTarget.key,
        async commit(request) {
          const host = getDocBlocksHost();
          if (origin.kind === 'loose-file') {
            const result = await host.external.commitText(
              origin.resourceId,
              request.content,
              request.persistedContent,
            );
            if (result.status === 'conflict') {
              pendingDbkConflictsRef.current.delete(baseTarget.key);
              if (result.content === null) await removeProviderEntry(fsProvider, filePath);
              else await writeProviderText(fsProvider, filePath, result.content);
              throw new DocumentCommitConflictError(
                'The original file changed outside DocBlocks.',
                result.content,
                result.version,
              );
            }
            await baseTarget.commit(request);
            pendingDbkConflictsRef.current.delete(baseTarget.key);
            gitScheduleRefresh();
            return { version: result.version };
          } else {
            const [{ MemoryContentContainer }, { containerToZip }] = await Promise.all([
              import('@bendyline/squisq/storage'),
              import('@bendyline/squisq-formats/container'),
            ]);
            const container = new MemoryContentContainer();
            await copyProviderToContainer(transient.provider, container, '');
            await container.writeFile(
              filePath.replace(/^\/+/, ''),
              new TextEncoder().encode(request.content),
            );
            const blob = await containerToZip(container);
            const result = await host.external.commitBinary(
              origin.resourceId,
              await blob.arrayBuffer(),
              origin.version,
            );
            if (result.status === 'conflict') {
              let externalContent: string | null = null;
              if (result.data) {
                if (!isMemoryWorkspaceProvider(transient.provider)) {
                  throw new Error('A transient DBK workspace must use in-memory storage.');
                }
                const snapshot = await decodeDbkWorkspace(result.data, {
                  targetDocumentPath: filePath,
                });
                externalContent = snapshot.documentContent;
                // Keep both branches intact until the user chooses. Reload
                // replaces the whole tree; Keep mine packages this untouched
                // local provider against the newly observed bundle version.
                pendingDbkConflictsRef.current.set(baseTarget.key, {
                  provider: transient.provider,
                  snapshot,
                });
              } else {
                pendingDbkConflictsRef.current.delete(baseTarget.key);
              }
              // Advance the optimistic origin only after the external bundle
              // has been completely staged. A parse/read failure must retry
              // against the old version rather than silently authorize an
              // overwrite of data we could not reconcile.
              origin.version = result.version;
              throw new DocumentCommitConflictError(
                'The original DocBlocks bundle changed outside DocBlocks.',
                externalContent,
                result.version,
              );
            }
            origin.version = result.version;
            // As with web-dbk above, the in-memory provider still represents
            // the preserved local branch rather than the external conflict
            // baseline. The origin commit is the conditional authority check;
            // now make the internal document agree with that acknowledged C
            // bundle without re-comparing A against B.
            await writeProviderText(fsProvider, filePath, request.content);
            pendingDbkConflictsRef.current.delete(baseTarget.key);
            gitScheduleRefresh();
            return { version: result.version };
          }
        },
      };
    },
    [gitScheduleRefresh],
  );

  /**
   * Per-file media container: for `notes.md`, images live in
   * `notes_files/` next to the markdown. Created lazily on first write,
   * picked up automatically if it already exists. Set up by the effect
   * below whenever the selected file (or backing provider) changes.
   */
  const mediaContainerRef = useRef<ContentContainer | null>(null);
  const [mediaProvider, setMediaProvider] = useState<MediaProvider | null>(null);
  const [mediaEpoch, setMediaEpoch] = useState(0);
  /**
   * Per-document container scoped to `<basename>_files/`. This is what
   * the editor uses for version history (`.versions/` lives here) and
   * for audio mapping (MP3 / timing.json discovery). Distinct from
   * `mediaContainerRef` which is scoped to the parent directory so the
   * media provider can write `notes_files/image.png` paths that stay
   * portable in the markdown.
   */
  const versionsContainerRef = useRef<ContentContainer | null>(null);
  const [versionsContainer, setVersionsContainer] = useState<ContentContainer | null>(null);

  /** Push a new history entry with the given hash. */
  const pushHash = useCallback((wsId: string, filePath?: string | null) => {
    const hash = buildHash(wsId, filePath);
    if (window.location.hash !== hash) {
      window.history.pushState(null, '', hash);
    }
  }, []);

  /** Open a workspace (and optionally a file) from identifiers.
   *  Returns the FileSystemProvider on success, or null on failure. */
  const openFromIds = useCallback(
    async (
      wsId: string,
      filePath: string | null,
      push: boolean,
      view?: EditorView,
      navigationRequestId?: number,
      sharedMode: SharedDocumentMode | null = null,
    ): Promise<FileSystemProvider | null> => {
      const requestId = navigationRequestId ?? ++navigationRequestRef.current;
      if (requestId !== navigationRequestRef.current) return null;
      // Transient (session-only) workspaces -- a loose file or `.dbk` opened
      // from the OS -- carry a pre-built in-memory provider in the registry.
      const transient = getTransientWorkspace(wsId);
      let ws: WorkspaceDescriptor | undefined;
      let fsProvider: FileSystemProvider | null = null;
      if (transient) {
        ws = transient.descriptor;
        fsProvider = transient.provider;
      } else {
        const workspaces = await listWorkspaces();
        ws = workspaces.find((w) => w.id === wsId);
        if (!ws) return null;
        if (ws.type === 'electron-native') {
          fsProvider = await createElectronProviderFromWorkspace(ws);
          if (!fsProvider) return null;
        } else if (ws.type === 'native') {
          const restored = await (await loadNativeFileSystem()).restoreNativeFolder(ws.id);
          if (!restored) return null;
          fsProvider = restored;
        } else {
          fsProvider = await createIndexedDbFileSystemProvider(ws.id, ws.name);
        }
      }
      if (!ws || !fsProvider) return null;
      let adopted = false;
      try {
        await touchWorkspace(ws.id);
        if (requestId !== navigationRequestRef.current) return null;

        let openedFile: string | null = null;
        let openedContent = '';
        const transitioned = await documentSession.transitionWithLoad(async () => {
          if (requestId !== navigationRequestRef.current) return null;
          if (filePath) {
            const content = await readProviderText(fsProvider, filePath);
            if (requestId !== navigationRequestRef.current) return null;
            if (content !== null) {
              openedFile = filePath;
              openedContent = content;
            }
          }

          return {
            target: openedFile ? createDocumentTarget(fsProvider, ws.id, openedFile) : null,
            content: openedContent,
          };
        });
        if (!transitioned) return null;

        // Once the session has accepted this target, ownership must follow it
        // even if a newer navigation request arrived in the final microtask.
        // The newer request will perform the next serialized transition.
        setProvider(fsProvider);
        adopted = true;
        setActiveWorkspaceId(ws.id);
        if (openedFile) {
          setSelectedFile(openedFile);
          setSelectedFolder(null);
          setFolderEntries([]);
          const effectiveView = view ?? 'wysiwyg';
          setInitialView(effectiveView);
          setInitialSharedMode(sharedMode);
          // Transient workspaces are session-only; don't persist them as the
          // "last opened" state (the id won't exist after a reload).
          if (!transient) {
            saveLastState({ workspaceId: wsId, filePath: openedFile, view: effectiveView });
          }
        } else {
          setSelectedFile(null);
          setSelectedFolder(null);
          setFolderEntries([]);
          setInitialSharedMode(null);
        }

        if (push) {
          pushHash(ws.id, openedFile);
        }
        return fsProvider;
      } finally {
        if (!transient && !adopted) await getFileSystemProviderV2(fsProvider)?.dispose();
      }
    },
    [createDocumentTarget, documentSession, pushHash],
  );

  const adoptTransientWorkspace = useCallback(
    async (options: {
      id: string;
      name: string;
      provider: MemoryFileSystemProvider;
      primaryFile: string;
      origin?: WorkspaceDescriptor['origin'];
      push: boolean;
      navigationRequestId?: number;
      view?: EditorView;
      sharedMode?: SharedDocumentMode | null;
    }): Promise<boolean> => {
      const descriptor: WorkspaceDescriptor = {
        id: options.id,
        name: options.name,
        type: 'transient',
        lastOpened: new Date().toISOString(),
        ...(options.origin ? { origin: options.origin } : {}),
      };
      let opened = false;
      registerTransientWorkspace(descriptor, options.provider);
      try {
        opened =
          (await openFromIds(
            options.id,
            `/${options.primaryFile.replace(/^\/+/, '')}`,
            options.push,
            options.view,
            options.navigationRequestId,
            options.sharedMode ?? null,
          )) !== null;
        return opened;
      } finally {
        if (!opened && getTransientWorkspace(options.id)?.provider === options.provider) {
          await unregisterTransientWorkspace(options.id);
        }
      }
    },
    [openFromIds],
  );

  const openSharedDocument = useCallback(
    async (payload: SharedDocumentPayload, navigationRequestId: number): Promise<boolean> => {
      const id = `transient-shared-${navigationRequestId}`;
      const mem = await createMemoryFileSystemProvider(id, 'Shared document');
      const primaryFile = 'shared.md';
      try {
        const snapshot = await decodeDbkWorkspace(payload.archive, {
          targetDocumentPath: primaryFile,
          profile: 'shared-link',
        });
        mem.replaceContents(snapshot);
      } catch (error: unknown) {
        await getFileSystemProviderV2(mem)?.dispose();
        throw error;
      }

      return adoptTransientWorkspace({
        id,
        name: 'Shared document',
        provider: mem,
        primaryFile,
        push: false,
        navigationRequestId,
        view: payload.mode ? 'preview' : 'wysiwyg',
        sharedMode: payload.mode,
      });
    },
    [adoptTransientWorkspace],
  );

  const seedWelcomeFile = useCallback(
    async (fs: FileSystemProvider, navigationRequestId?: number) => {
      const isCurrent = () =>
        navigationRequestId === undefined || navigationRequestId === navigationRequestRef.current;
      if (!isCurrent()) return;
      const entries = await readProviderDirectory(fs, '/');
      if (!isCurrent()) return;

      // If the only file is the welcome doc, auto-select it.
      // Match either casing so workspaces seeded before the rename
      // (aboutDocblocks.md) keep working alongside new ones (aboutDocBlocks.md).
      if (
        entries.length === 1 &&
        entries[0].kind === 'file' &&
        entries[0].path.replace(/^\//, '').toLowerCase() === 'aboutdocblocks.md'
      ) {
        const aboutPath = entries[0].path;
        const content = await readProviderText(fs, aboutPath);
        if (content !== null && isCurrent()) {
          await documentSession.transitionTo(createDocumentTarget(fs, fs.id, aboutPath), content);
          if (!isCurrent()) return;
          setSelectedFile(aboutPath);
          setInitialView('preview');
          setInitialSharedMode(null);
          setExplorerKey((k) => k + 1);
          pushHash(fs.id, aboutPath);
          saveLastState({ workspaceId: fs.id, filePath: aboutPath, view: 'preview' });
          if (!isWelcomeGatewayDismissed()) setShowWelcomeGateway(true);
        }
        return;
      }

      if (entries.length > 0) return;

      const welcomePath = WELCOME_DOCUMENT_PATH;
      const welcomeContent = WELCOME_DOCUMENT_CONTENT;

      let seededContent = welcomeContent;
      try {
        await writeProviderText(fs, welcomePath, welcomeContent, 'create');
      } catch (error: unknown) {
        if (!(error instanceof FsError && error.code === 'already-exists')) throw error;
        const existing = await readProviderText(fs, welcomePath);
        if (existing === null) throw error;
        seededContent = existing;
      }
      if (!isCurrent()) return;
      await documentSession.transitionTo(
        createDocumentTarget(fs, fs.id, welcomePath),
        seededContent,
      );
      if (!isCurrent()) return;
      setSelectedFile(welcomePath);
      setInitialView('preview');
      setInitialSharedMode(null);
      setExplorerKey((k) => k + 1);
      pushHash(fs.id, welcomePath);
      saveLastState({ workspaceId: fs.id, filePath: welcomePath, view: 'preview' });
      if (!isWelcomeGatewayDismissed()) setShowWelcomeGateway(true);
    },
    [createDocumentTarget, documentSession, pushHash],
  );

  // Startup is a mount lifecycle, not a reaction to callback identity. Keep
  // the latest implementations available without letting git/provider state
  // changes restart initialization and supersede an OS-open navigation.
  const startupOpenFromIdsRef = useRef(openFromIds);
  startupOpenFromIdsRef.current = openFromIds;
  const startupOpenSharedDocumentRef = useRef(openSharedDocument);
  startupOpenSharedDocumentRef.current = openSharedDocument;
  const startupSeedWelcomeFileRef = useRef(seedWelcomeFile);
  startupSeedWelcomeFileRef.current = seedWelcomeFile;

  /** Hide the welcome gateway and never show it again. Safe to call from
   *  paths where it may not be showing -- only persists when it was. */
  const closeWelcomeGateway = useCallback(() => {
    setShowWelcomeGateway((showing) => {
      if (showing) markWelcomeGatewayDismissed();
      return false;
    });
  }, []);

  /** Gateway CTA -- flip the welcome doc from Play into the editor. */
  const handleStartWriting = useCallback(() => {
    closeWelcomeGateway();
    setInitialView('wysiwyg');
    setInitialSharedMode(null);
    setEditorPresentationEpoch((epoch) => epoch + 1);
    if (activeWorkspaceId && selectedFile) {
      saveLastState({ workspaceId: activeWorkspaceId, filePath: selectedFile, view: 'wysiwyg' });
    }
  }, [closeWelcomeGateway, activeWorkspaceId, selectedFile]);

  // Initialise workspace on mount -- restore from hash or last-used
  useEffect(() => {
    const requestId = ++navigationRequestRef.current;
    let cancelled = false;
    const isCurrent = () => !cancelled && requestId === navigationRequestRef.current;

    void (async () => {
      const electron = isElectronHost();
      let workspaceIdRemap: Readonly<Record<string, string>> = {};
      if (electron) {
        // Main-process persisted roots are authoritative after an upgrade or
        // collision repair. Reconcile renderer metadata before hash or
        // last-state restoration so an obsolete id cannot reopen a different
        // folder that once shared its legacy id.
        try {
          const localWorkspaces = await listWorkspaces();
          const hostWorkspaces = await getDocBlocksHost().workspaces.list();
          const reconciliation = reconcileElectronWorkspaceDescriptors(
            localWorkspaces,
            hostWorkspaces,
            getDocBlocksHost().env.platform,
            new Date().toISOString(),
          );
          for (const id of reconciliation.removeIds) await removeWorkspace(id);
          for (const workspace of reconciliation.upsert) await saveWorkspace(workspace);
          workspaceIdRemap = reconciliation.idRemap;
        } catch {
          workspaceAuthorityBarrier.markReady();
          if (isCurrent()) {
            setWorkspaceStartupError(
              'DocBlocks could not verify access to your saved workspaces. Restart the app or open the folder again.',
            );
          }
          return;
        }
      }
      workspaceAuthorityBarrier.markReady();
      if (!isCurrent()) return;

      // Shared links are a distinct, bounded wire format. Never let malformed
      // shared input fall through and become a workspace id.
      const sharedHash = parseSharedDocumentHash(window.location.hash);
      if (sharedHash.kind === 'invalid') {
        setWorkspaceStartupError(sharedHash.message);
        return;
      }
      if (sharedHash.kind === 'valid') {
        try {
          const opened = await startupOpenSharedDocumentRef.current(sharedHash.payload, requestId);
          if (!isCurrent()) return;
          if (!opened) {
            setWorkspaceStartupError('This shared document link could not be opened.');
          }
        } catch (error: unknown) {
          if (isCurrent()) {
            setWorkspaceStartupError(
              error instanceof Error
                ? `This shared document link could not be opened: ${error.message}`
                : 'This shared document link could not be opened.',
            );
          }
        }
        return;
      }

      // Try restoring an ordinary workspace route from the URL hash first.
      const hashState = parseHash();
      if (hashState) {
        const migratedWorkspaceId = workspaceIdRemap[hashState.workspaceId];
        const restoredWorkspaceId = migratedWorkspaceId ?? hashState.workspaceId;
        if (migratedWorkspaceId) {
          window.history.replaceState(null, '', buildHash(restoredWorkspaceId, hashState.filePath));
        }
        const restoredProvider = await startupOpenFromIdsRef.current(
          restoredWorkspaceId,
          hashState.filePath,
          false,
          undefined,
          requestId,
        );
        if (!isCurrent()) return;
        if (restoredProvider) {
          // If the hash had no file, check whether we should auto-select the welcome doc
          if (!hashState.filePath) {
            await startupSeedWelcomeFileRef.current(restoredProvider, requestId);
          }
          return;
        }
      }

      // Try restoring last viewed document from localStorage
      const lastState = loadLastState();
      if (lastState) {
        const restoredWorkspaceId =
          workspaceIdRemap[lastState.workspaceId] ?? lastState.workspaceId;
        if (restoredWorkspaceId !== lastState.workspaceId) {
          saveLastState({ ...lastState, workspaceId: restoredWorkspaceId });
        }
        const restoredProvider = await startupOpenFromIdsRef.current(
          restoredWorkspaceId,
          lastState.filePath,
          true,
          lastState.view,
          requestId,
        );
        if (!isCurrent()) return;
        if (restoredProvider) return;
      }

      let fsProvider: FileSystemProvider | null = null;

      const workspaces = await listWorkspaces();
      if (!isCurrent()) return;
      // On desktop, hide web-only workspaces (indexeddb/native) -- only
      // folder-based workspaces are valid.
      const candidates = electron
        ? workspaces.filter((w) => w.type === 'electron-native')
        : workspaces.filter((w) => w.type !== 'electron-native');
      // Pick the most recently opened workspace
      const sorted = [...candidates].sort((a, b) =>
        (b.lastOpened ?? '').localeCompare(a.lastOpened ?? ''),
      );
      for (const ws of sorted) {
        if (ws.type === 'electron-native') {
          const p = await createElectronProviderFromWorkspace(ws);
          if (!p) continue;
          if (!isCurrent()) {
            await getFileSystemProviderV2(p)?.dispose();
            return;
          }
          await touchWorkspace(ws.id);
          if (!isCurrent()) {
            await getFileSystemProviderV2(p)?.dispose();
            return;
          }
          fsProvider = p;
          break;
        } else if (ws.type === 'native') {
          const restored = await (await loadNativeFileSystem()).restoreNativeFolder(ws.id);
          if (restored) {
            if (!isCurrent()) {
              await getFileSystemProviderV2(restored)?.dispose();
              return;
            }
            await touchWorkspace(ws.id);
            if (!isCurrent()) {
              await getFileSystemProviderV2(restored)?.dispose();
              return;
            }
            fsProvider = restored;
            break;
          }
        } else {
          const p = await createIndexedDbFileSystemProvider(ws.id, ws.name);
          if (!isCurrent()) {
            await getFileSystemProviderV2(p)?.dispose();
            return;
          }
          await touchWorkspace(ws.id);
          if (!isCurrent()) {
            await getFileSystemProviderV2(p)?.dispose();
            return;
          }
          fsProvider = p;
          break;
        }
      }

      if (!fsProvider) {
        if (electron) {
          // Desktop: ask the host for the default folder workspace
          // (creates DocBlocks in the OS-resolved Documents folder on first launch).
          const info = await getDocBlocksHost().workspaces.getDefault();
          if (!isCurrent()) return;
          const descriptor: WorkspaceDescriptor = {
            id: info.id,
            name: info.name,
            type: 'electron-native',
            rootPath: info.rootPath,
            lastOpened: new Date().toISOString(),
          };
          await saveWorkspace(descriptor);
          if (!isCurrent()) return;
          const p = await createElectronFileSystemProvider(info.id, info.name, info.rootPath);
          if (!isCurrent()) {
            await getFileSystemProviderV2(p)?.dispose();
            return;
          }
          fsProvider = p;
        } else {
          // Web: create the IndexedDB default workspace
          const defaultWs = await ensureDefaultWorkspace();
          if (!isCurrent()) return;
          const p = await createIndexedDbFileSystemProvider(defaultWs.id, defaultWs.name);
          if (!isCurrent()) {
            await getFileSystemProviderV2(p)?.dispose();
            return;
          }
          fsProvider = p;
        }
      }

      let adopted = false;
      try {
        if (!isCurrent()) return;
        // Set the root hash before seeding; seedWelcomeFile replaces it with
        // the welcome path when it opens that document.
        pushHash(fsProvider.id, null);
        await startupSeedWelcomeFileRef.current(fsProvider, requestId);
        if (!isCurrent()) return;
        setProvider(fsProvider);
        setActiveWorkspaceId(fsProvider.id);
        adopted = true;
      } finally {
        if (!adopted) await getFileSystemProviderV2(fsProvider)?.dispose();
      }
    })().catch(() => {
      if (isCurrent()) {
        setWorkspaceStartupError(
          'DocBlocks could not initialize your workspace. Restart the app or open the folder again.',
        );
      }
    });

    return () => {
      cancelled = true;
      if (navigationRequestRef.current === requestId) navigationRequestRef.current += 1;
    };
  }, [pushHash, workspaceAuthorityBarrier]);

  // Handle browser back/forward
  useEffect(() => {
    const onPopState = () => {
      const requestedHash = window.location.hash;
      const restoreCurrentHash = () => {
        if (!activeWorkspaceId || window.location.hash !== requestedHash) return;
        window.history.replaceState(null, '', buildHash(activeWorkspaceId, selectedFile));
      };
      const sharedHash = parseSharedDocumentHash(requestedHash);
      if (sharedHash.kind === 'invalid') {
        restoreCurrentHash();
        showToast('error', sharedHash.message);
        return;
      }
      if (sharedHash.kind === 'valid') {
        const requestId = ++navigationRequestRef.current;
        void openSharedDocument(sharedHash.payload, requestId)
          .then((opened) => {
            if (!opened) restoreCurrentHash();
          })
          .catch((error: unknown) => {
            restoreCurrentHash();
            showToast(
              'error',
              error instanceof Error
                ? 'DocBlocks could not open the shared document: ' + error.message
                : 'DocBlocks could not open the shared document.',
            );
          });
        return;
      }

      const hashState = parseHash();
      if (hashState) {
        void openFromIds(hashState.workspaceId, hashState.filePath, false)
          .then((opened) => {
            if (!opened) restoreCurrentHash();
          })
          .catch((error: unknown) => {
            restoreCurrentHash();
            showToast(
              'error',
              error instanceof Error
                ? 'DocBlocks could not switch documents: ' + error.message
                : 'DocBlocks could not switch documents.',
            );
          });
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [activeWorkspaceId, openFromIds, openSharedDocument, selectedFile, showToast]);

  useEffect(() => {
    if (!showBrowserStorageWarning || typeof navigator === 'undefined') return;
    const storage = navigator.storage;
    if (!storage || typeof storage.persisted !== 'function') return;

    let cancelled = false;
    void storage
      .persisted()
      .then((persistent) => {
        if (!cancelled) setBrowserStoragePersistent(persistent);
      })
      .catch(() => {
        // Ignore unsupported/denied checks; the menu action can still try persist().
      });

    return () => {
      cancelled = true;
    };
  }, [showBrowserStorageWarning]);

  // Browser PWA install plumbing. Chromium fires `beforeinstallprompt` when
  // the app is installable; stashing it (after preventDefault) lets the app
  // menu offer "Install DocBlocks…" on our terms. `appinstalled` fires for
  // any install path (menu item or the browser's own omnibox affordance).
  useEffect(() => {
    if (isElectronHost() || typeof window === 'undefined') return;
    const onBeforeInstallPrompt = (e: BeforeInstallPromptEvent) => {
      e.preventDefault();
      setInstallPromptEvent(e);
    };
    const onAppInstalled = () => {
      setInstallPromptEvent(null);
      // Chromium auto-grants persistent storage to installed apps -- re-probe
      // so the "Keep data in browser for longer" nag retires itself.
      const storage = navigator.storage;
      if (storage && typeof storage.persisted === 'function') {
        storage
          .persisted()
          .then((persistent) => {
            if (persistent) setBrowserStoragePersistent(true);
          })
          .catch(() => {
            // Probe is best-effort; the manual menu action still works.
          });
      }
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const handleInstallApp = useCallback(async () => {
    const promptEvent = installPromptEvent;
    // prompt() is single-use: clear the stash up front and rely on the
    // browser re-firing beforeinstallprompt if the user dismisses.
    setInstallPromptEvent(null);
    if (!promptEvent) return;
    try {
      await promptEvent.prompt();
      await promptEvent.userChoice;
    } catch {
      // The prompt was already consumed or is not allowed right now.
    }
  }, [installPromptEvent]);

  // Track view mode changes (Editor/Raw/Play tabs) and persist to localStorage
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest?.('[data-view]');
      if (target) {
        const view = target.getAttribute('data-view') as EditorView;
        if (view) {
          // The user found the view tabs on their own -- the gateway's job is done.
          closeWelcomeGateway();
        }
        if (view && activeWorkspaceId && selectedFile) {
          saveLastState({ workspaceId: activeWorkspaceId, filePath: selectedFile, view });
        }
      }
    };
    window.addEventListener('click', handler, true);
    return () => window.removeEventListener('click', handler, true);
  }, [activeWorkspaceId, selectedFile, closeWelcomeGateway]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const sKey = e.key === 's' || e.key === 'S';
      const accel = e.ctrlKey || e.metaKey;
      if (!sKey || !accel || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      void (async () => {
        try {
          await documentSession.flush('manual');
          showToast('success', 'Saved. You’re all set.');
        } catch (error: unknown) {
          showToast(
            'error',
            isQuotaExceededError(error)
              ? 'Could not save -- browser storage is full. Free up space or back up your work.'
              : error instanceof Error
                ? error.message
                : 'Could not save this document.',
          );
        }
      })();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [documentSession, showToast]);
  useEffect(() => {
    return () => {
      if (saveToastTimerRef.current) clearTimeout(saveToastTimerRef.current);
    };
  }, []);

  // One-time passive notice when the host reports the app is fully cached
  // for offline use. Mirrors the save toast's look and self-dismissal.
  const [offlineReadyToast, setOfflineReadyToast] = useState(false);
  const offlineReadyAnnouncedRef = useRef(false);
  useEffect(() => {
    if (!offlineReady || offlineReadyAnnouncedRef.current) return;
    offlineReadyAnnouncedRef.current = true;
    setOfflineReadyToast(true);
    const timer = setTimeout(() => setOfflineReadyToast(false), 3000);
    return () => clearTimeout(timer);
  }, [offlineReady]);

  // Quota-exhaustion banner. The session clears `error` on every keystroke
  // and at each retry, so the raw snapshot flickers during a failing
  // type/retry loop -- latch it, and release only when a commit succeeds.
  // Known gap: version-snapshot writes (squisq's DocumentVersionManager)
  // swallow their own failures upstream (`SaveVersionResult` has no error
  // variant), but they hit the same provider, so the primary autosave
  // latches this banner within one edit cycle anyway.
  const [storageFull, setStorageFull] = useState(false);
  useEffect(() => {
    if (documentSnapshot.error && isQuotaExceededError(documentSnapshot.error)) {
      setStorageFull(true);
    } else if (documentSnapshot.status === 'saved') {
      setStorageFull(false);
    }
  }, [documentSnapshot.error, documentSnapshot.status]);

  // Ask the browser to make origin storage durable the first time real work
  // is saved (browser surface only, once per session). Chromium decides
  // silently -- installed apps are auto-granted; Firefox may show one prompt
  // at this meaningful moment rather than at page load.
  const autoPersistRequestedRef = useRef(false);
  useEffect(() => {
    if (!showBrowserStorageWarning || browserStoragePersistent) return;
    if (autoPersistRequestedRef.current) return;
    if (documentSnapshot.status !== 'saved') return;
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!storage || typeof storage.persist !== 'function') return;
    autoPersistRequestedRef.current = true;
    storage
      .persist()
      .then((granted) => {
        if (granted) setBrowserStoragePersistent(true);
      })
      .catch(() => {
        // Best-effort; the manual menu action remains available.
      });
  }, [showBrowserStorageWarning, browserStoragePersistent, documentSnapshot.status]);

  // Per-file media: for `notes.md` images live in `notes_files/` beside it.
  // Rebuilds whenever the provider or selected file changes.
  useEffect(() => {
    if (!provider || !selectedFile) {
      mediaContainerRef.current = null;
      versionsContainerRef.current = null;
      setMediaProvider(null);
      setVersionsContainer(null);
      return;
    }
    const parentDir = dirnameOf(selectedFile);
    const base = basenameOf(selectedFile);
    const baseNoExt = base.replace(/\.[^.]+$/, '');
    const container = new FileSystemContentContainer(provider, parentDir);
    const vPrefix = parentDir ? `${parentDir}/${baseNoExt}_files` : `${baseNoExt}_files`;
    const vContainer = new FileSystemContentContainer(provider, vPrefix);
    const mp = createFileMediaProvider(container, base);
    mediaContainerRef.current = container;
    versionsContainerRef.current = vContainer;
    setMediaProvider(mp);
    setVersionsContainer(vContainer);
    return () => {
      mp.dispose();
    };
  }, [provider, selectedFile, mediaEpoch]);

  const documentLinkProvider = useDocumentLinkProvider(provider, selectedFile, documentLinkEpoch);

  // Expose a DocumentVersionManager via versioningRef when requested.
  useEffect(() => {
    const ref = versioningRef;
    if (!ref) return;
    const assign = (mgr: DocumentVersionManager | null) => {
      if (typeof ref === 'function') ref(mgr);
      else (ref as React.MutableRefObject<DocumentVersionManager | null>).current = mgr;
    };
    if (!effectiveVersioning || !versionsContainer || !selectedFile) {
      assign(null);
      return;
    }
    const base = stripExtension(basenameOf(selectedFile));
    const mgr = new DocumentVersionManager(versionsContainer, {
      basename: versionBasename ?? base,
    });
    assign(mgr);
    return () => assign(null);
  }, [versioningRef, effectiveVersioning, versionBasename, selectedFile, versionsContainer]);

  // React to external file changes watched by the Electron host (chokidar).
  useEffect(() => {
    if (!provider) return;
    const providerV2 = getFileSystemProviderV2(provider);
    if (!providerV2?.capabilities.watch) return;
    if (!selectedFile || !documentSnapshot.targetKey) return;
    const watchedFile = selectedFile;
    const targetKey = documentSnapshot.targetKey;
    let disposed = false;
    let reading = false;
    let rerun = false;
    let observationSequence = 0;

    const drainWatcherReads = async () => {
      if (reading) {
        rerun = true;
        return;
      }
      reading = true;
      try {
        do {
          rerun = false;
          const sequence = ++observationSequence;
          const external = await readStableFileSnapshot(provider, watchedFile);
          if (disposed) return;
          const result = documentSession.observeExternal({
            targetKey,
            sequence,
            content: external.content,
            version: external.version,
          });
          if (result === 'applied') {
            // observeExternal increments the session generation. The editor
            // remount key and content both derive from that snapshot.
          }
        } while (rerun && !disposed);
      } catch {
        // The next watcher event will retry a file that was changing too
        // quickly to obtain a stable content/metadata pair.
      } finally {
        reading = false;
        if (rerun && !disposed) void drainWatcherReads();
      }
    };

    const subscription = providerV2.watch(
      (event) => {
        if (event.type === 'overflow') {
          void drainWatcherReads();
          return;
        }
        const changedCurrent = sameProviderPath(event.path, watchedFile);
        const changedDestination =
          event.destinationPath !== null && sameProviderPath(event.destinationPath, watchedFile);
        if (changedCurrent || changedDestination) void drainWatcherReads();
      },
      {
        onError: () => {
          // Re-read the active file on watcher failure. The session decides
          // whether the result is a clean update or an external conflict.
          void drainWatcherReads();
        },
      },
    );
    void subscription.ready.catch(() => undefined);
    return () => {
      disposed = true;
      void subscription.dispose();
    };
  }, [provider, selectedFile, documentSession, documentSnapshot.targetKey]);

  const transitionAwayFromDocument = useCallback(
    async (requestId: number): Promise<boolean> => {
      if (requestId !== navigationRequestRef.current) return false;
      try {
        const transitioned = await documentSession.transitionWithLoad(async () =>
          requestId === navigationRequestRef.current ? { target: null, content: '' } : null,
        );
        if (!transitioned || requestId !== navigationRequestRef.current) return false;
        return true;
      } catch (error: unknown) {
        showToast(
          'error',
          error instanceof Error
            ? 'DocBlocks could not save this document: ' + error.message
            : 'DocBlocks could not save this document.',
        );
        return false;
      }
    },
    [documentSession, showToast],
  );

  const handleUseExternalDocument = useCallback(async () => {
    const conflictKey = documentSession.getSnapshot().conflict?.targetKey;
    const pendingDbk = conflictKey ? pendingDbkConflictsRef.current.get(conflictKey) : undefined;
    try {
      if (pendingDbk) {
        pendingDbk.provider.replaceContents(pendingDbk.snapshot);
        pendingDbkConflictsRef.current.delete(conflictKey!);
        setDocumentLinkEpoch((epoch) => epoch + 1);
        setMediaEpoch((epoch) => epoch + 1);
        setExplorerKey((key) => key + 1);
      }
      const snapshot = await documentSession.resolveConflict('use-external');
      if (!snapshot.targetKey) {
        setSelectedFile(null);
        if (activeWorkspaceId) pushHash(activeWorkspaceId, null);
      }
    } catch (error: unknown) {
      setSaveToast({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not reload the external document.',
      });
    }
  }, [activeWorkspaceId, documentSession, pushHash]);

  const handleKeepLocalDocument = useCallback(async () => {
    const conflictKey = documentSession.getSnapshot().conflict?.targetKey;
    try {
      await documentSession.resolveConflict('use-local');
      if (conflictKey) pendingDbkConflictsRef.current.delete(conflictKey);
      setSaveToast({ kind: 'success', message: 'Your version was saved.' });
    } catch (error: unknown) {
      setSaveToast({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not save your version.',
      });
    }
  }, [documentSession]);

  useEffect(() => {
    const needsWarning = ['dirty', 'saving', 'error', 'conflict'].includes(documentSnapshot.status);
    if (!documentSnapshot.targetKey) return;
    const flushBestEffort = () => {
      void documentSession.flush('close').catch(() => {
        // A browser cannot await asynchronous storage during teardown. The
        // beforeunload warning remains active when persistence is unresolved.
      });
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      flushBestEffort();
      if (!needsWarning) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const onPageHide = () => flushBestEffort();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushBestEffort();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [documentSession, documentSnapshot.status, documentSnapshot.targetKey]);

  // Electron can defer window destruction and await this acknowledgement.
  // Browser unload remains best-effort, which is why continuous autosave is
  // still the primary durability mechanism.
  useEffect(() => {
    if (!isElectronHost()) return;
    const lifecycle = getDocBlocksHost().lifecycle;
    const stopPrepare = lifecycle.onPrepareClose(async (request) => {
      preparedCloseRequestRef.current = request.requestId;
      try {
        const snapshot = await documentSession.prepareClose();
        return { status: 'ready' as const, persistedRevision: snapshot.persistedRevision };
      } catch (error: unknown) {
        preparedCloseRequestRef.current = null;
        return {
          status: 'blocked' as const,
          code:
            error instanceof DocumentSessionConflictError
              ? ('external-conflict' as const)
              : ('save-failed' as const),
          message: error instanceof Error ? error.message : 'Could not save the document.',
        };
      }
    });
    const stopCancel = lifecycle.onCancelClose((requestId) => {
      if (preparedCloseRequestRef.current !== requestId) return;
      preparedCloseRequestRef.current = null;
      documentSession.cancelClose();
    });
    return () => {
      stopPrepare();
      stopCancel();
    };
  }, [documentSession]);

  const handleWorkspaceSelect = useCallback(
    async (ws: WorkspaceDescriptor) => {
      const requestId = ++navigationRequestRef.current;
      await touchWorkspace(ws.id);
      if (requestId !== navigationRequestRef.current) return;
      let nextProvider: FileSystemProvider | null = null;
      const transient = getTransientWorkspace(ws.id);
      if (transient) {
        nextProvider = transient.provider;
      } else if (ws.type === 'electron-native') {
        nextProvider = await createElectronProviderFromWorkspace(ws);
        if (!nextProvider) return;
      } else if (ws.type === 'native') {
        const restored = await (await loadNativeFileSystem()).restoreNativeFolder(ws.id);
        if (!restored) {
          // Permission denied or handle lost -- fall through without changing provider
          return;
        }
        nextProvider = restored;
      } else {
        nextProvider = await createIndexedDbFileSystemProvider(ws.id, ws.name);
      }
      if (requestId !== navigationRequestRef.current) return;
      if (!(await transitionAwayFromDocument(requestId))) return;
      setProvider(nextProvider);
      setActiveWorkspaceId(ws.id);
      setSelectedFile(null);
      setSelectedFolder(null);
      setFolderEntries([]);
      pushHash(ws.id, null);
    },
    [pushHash, transitionAwayFromDocument],
  );

  const unpinDocument = useCallback((document: Pick<PinnedDocument, 'workspaceId' | 'path'>) => {
    const key = pinnedDocumentKey(document);
    setPinnedDocuments((current) => removePinnedDocument(current, document));
    setPinnedDocumentAvailability((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }, []);

  const confirmMissingPinnedDocument = useCallback(
    async (document: PinnedDocument) => {
      setPinnedAvailability(document, 'missing');
      const shouldUnpin = await confirmAction({
        title: 'File not found',
        message: missingPinnedDocumentMessage(document),
        confirmLabel: 'OK',
        cancelLabel: 'Cancel',
      });
      if (shouldUnpin) unpinDocument(document);
    },
    [confirmAction, setPinnedAvailability, unpinDocument],
  );

  const handleTogglePin = useCallback(
    (path: string) => {
      if (!activeWorkspaceId || !provider) return;
      const canonicalPath = parseWorkspacePath(path);
      if (!canonicalPath) return;
      const document: PinnedDocument = {
        workspaceId: activeWorkspaceId,
        workspaceName: activeWorkspaceDescriptor?.name ?? provider.label,
        path: canonicalPath,
      };
      const alreadyPinned = pinnedDocuments.some(
        (candidate) => pinnedDocumentKey(candidate) === pinnedDocumentKey(document),
      );
      setPinnedDocuments((current) => togglePinnedDocument(current, document));
      if (alreadyPinned) {
        setPinnedDocumentAvailability((current) => {
          const key = pinnedDocumentKey(document);
          if (!current.has(key)) return current;
          const next = new Map(current);
          next.delete(key);
          return next;
        });
      } else {
        setPinnedAvailability(document, 'available');
      }
    },
    [
      activeWorkspaceDescriptor?.name,
      activeWorkspaceId,
      pinnedDocuments,
      provider,
      setPinnedAvailability,
    ],
  );

  const activeWorkspacePinnedPaths = useMemo(
    () =>
      pinnedDocuments
        .filter((document) => document.workspaceId === activeWorkspaceId)
        .map((document) => document.path),
    [activeWorkspaceId, pinnedDocuments],
  );

  const handlePinnedDocumentSelect = useCallback(
    async (document: PinnedDocumentListItem) => {
      const requestId = ++navigationRequestRef.current;
      const workspace = await getWorkspace(document.workspaceId);
      if (requestId !== navigationRequestRef.current) return;
      if (!workspace) {
        await confirmMissingPinnedDocument(document);
        return;
      }

      let nextProvider: FileSystemProvider | null =
        activeWorkspaceId === workspace.id ? provider : null;
      let ownsNextProvider = false;
      let adoptedNextProvider = nextProvider !== null;
      try {
        if (!nextProvider) {
          const transient = getTransientWorkspace(workspace.id);
          if (transient) {
            nextProvider = transient.provider;
          } else if (workspace.type === 'electron-native') {
            nextProvider = isElectronHost()
              ? await createElectronProviderFromWorkspace(workspace)
              : null;
            ownsNextProvider = nextProvider !== null;
          } else if (workspace.type === 'native') {
            nextProvider = await (await loadNativeFileSystem()).restoreNativeFolder(workspace.id);
            ownsNextProvider = nextProvider !== null;
          } else {
            nextProvider = await createIndexedDbFileSystemProvider(workspace.id, workspace.name);
            ownsNextProvider = true;
          }
        }
        if (requestId !== navigationRequestRef.current) return;
        if (!nextProvider) {
          setPinnedAvailability(document, 'unknown');
          showToast(
            'error',
            `DocBlocks could not open “${workspace.name}”. Open that workspace and grant access, then try again.`,
          );
          return;
        }
        const openedProvider = nextProvider;

        let exists: boolean;
        try {
          exists = await providerEntryExists(openedProvider, document.path);
        } catch (error: unknown) {
          setPinnedAvailability(document, 'unknown');
          showToast(
            'error',
            error instanceof Error ? error.message : 'Could not check the pinned document.',
          );
          return;
        }
        if (requestId !== navigationRequestRef.current) return;
        if (!exists) {
          await confirmMissingPinnedDocument(document);
          return;
        }

        let disappearedDuringRead = false;
        const transitioned = await documentSession.transitionWithLoad(async () => {
          if (requestId !== navigationRequestRef.current) return null;
          const content = await readProviderText(openedProvider, document.path);
          if (content === null) {
            disappearedDuringRead = true;
            return null;
          }
          if (requestId !== navigationRequestRef.current) return null;
          return {
            target: createDocumentTarget(openedProvider, workspace.id, document.path),
            content,
          };
        });
        if (!transitioned) {
          if (disappearedDuringRead) await confirmMissingPinnedDocument(document);
          return;
        }
        if (requestId !== navigationRequestRef.current) return;

        adoptedNextProvider = true;
        setProvider(openedProvider);
        setActiveWorkspaceId(workspace.id);
        setActiveWorkspaceDescriptor(workspace);
        setSelectedFile(document.path);
        setSelectedFolder(null);
        setFolderEntries([]);
        setInitialView('wysiwyg');
        setInitialSharedMode(null);
        setExplorerKey((key) => key + 1);
        setPinnedAvailability(document, 'available');
        closeWelcomeGateway();
        pushHash(workspace.id, document.path);
        saveLastState({ workspaceId: workspace.id, filePath: document.path, view: 'wysiwyg' });
        if (effectiveCompact) setMobileShowEditor(true);
        void touchWorkspace(workspace.id).catch(() => undefined);
      } catch (error: unknown) {
        showToast(
          'error',
          error instanceof Error ? error.message : 'Could not open the pinned document.',
        );
      } finally {
        if (nextProvider && ownsNextProvider && !adoptedNextProvider) {
          try {
            await getFileSystemProviderV2(nextProvider)?.dispose();
          } catch {
            // Preserve the navigation result; disposal is best-effort here.
          }
        }
      }
    },
    [
      activeWorkspaceId,
      closeWelcomeGateway,
      confirmMissingPinnedDocument,
      createDocumentTarget,
      documentSession,
      effectiveCompact,
      provider,
      pushHash,
      setPinnedAvailability,
      showToast,
    ],
  );

  const handleMoveTransientWorkspace = useCallback(
    async (destinationWorkspaceId: string) => {
      if (!activeWorkspaceId || !provider || !selectedFile) {
        throw new Error('Select the temporary document before moving it.');
      }
      const transient = getTransientWorkspace(activeWorkspaceId);
      if (!transient || transient.provider !== provider) {
        throw new Error('This workspace is no longer temporary.');
      }
      const destination = transientMoveDestinations.find(
        (workspace) => workspace.id === destinationWorkspaceId,
      );
      if (!destination) {
        throw new Error('That destination workspace is no longer available.');
      }

      const requestId = ++navigationRequestRef.current;
      let destinationProvider: FileSystemProvider | null = null;
      let adoptedDestination = false;
      const sourceTargetKey = documentSnapshot.targetKey;

      try {
        if (destination.type === 'electron-native') {
          destinationProvider = await createElectronProviderFromWorkspace(destination);
        } else if (destination.type === 'native') {
          destinationProvider = await (
            await loadNativeFileSystem()
          ).restoreNativeFolder(destination.id);
        } else {
          destinationProvider = await createIndexedDbFileSystemProvider(
            destination.id,
            destination.name,
          );
        }
        if (!destinationProvider) {
          throw new Error(
            `DocBlocks could not open “${destination.name}”. Open that workspace and grant access, then try again.`,
          );
        }
        const openedDestination = destinationProvider;

        const moved = await documentSession.transitionWithLoad(async () => {
          if (requestId !== navigationRequestRef.current) return null;
          const content = await readProviderText(provider, selectedFile);
          if (content === null) {
            throw new Error('The temporary document is no longer available.');
          }
          await copyTransientWorkspaceContents(provider, openedDestination);
          return {
            target: createDocumentTarget(openedDestination, destination.id, selectedFile),
            content,
          };
        });
        if (!moved) {
          throw new Error('The move was interrupted by another navigation request.');
        }

        adoptedDestination = true;
        setProvider(openedDestination);
        setActiveWorkspaceId(destination.id);
        setActiveWorkspaceDescriptor(destination);
        setSelectedFile(selectedFile);
        setPinnedDocuments((current) =>
          movePinnedDocumentsToWorkspace(current, activeWorkspaceId, {
            workspaceId: destination.id,
            workspaceName: destination.name,
          }),
        );
        setSelectedFolder(null);
        setFolderEntries([]);
        setInitialView('wysiwyg');
        setInitialSharedMode(null);
        setExplorerKey((key) => key + 1);
        closeWelcomeGateway();
        pushHash(destination.id, selectedFile);
        saveLastState({
          workspaceId: destination.id,
          filePath: selectedFile,
          view: 'wysiwyg',
        });
        if (effectiveCompact) setMobileShowEditor(true);
        void touchWorkspace(destination.id).catch(() => undefined);
        if (sourceTargetKey) pendingDbkConflictsRef.current.delete(sourceTargetKey);

        const origin = transient.descriptor.origin;
        if (isElectronHost() && origin && (origin.kind === 'loose-file' || origin.kind === 'dbk')) {
          try {
            await getDocBlocksHost().external.revoke(origin.resourceId);
          } catch {
            // Navigation and renderer teardown also revoke external grants.
          }
        }
        try {
          await removeWorkspace(activeWorkspaceId);
        } catch {
          // The transient registry forgets the entry before provider disposal;
          // a disposal failure must not make a successful move look undone.
        }
        setDescriptorRefreshKey((key) => key + 1);
      } catch (error: unknown) {
        if (destinationProvider && !adoptedDestination) {
          try {
            await getFileSystemProviderV2(destinationProvider)?.dispose();
          } catch {
            // Preserve the move failure as the actionable error.
          }
        }
        throw error;
      }
    },
    [
      activeWorkspaceId,
      closeWelcomeGateway,
      createDocumentTarget,
      documentSession,
      documentSnapshot.targetKey,
      effectiveCompact,
      provider,
      pushHash,
      selectedFile,
      transientMoveDestinations,
    ],
  );

  const handleOpenFolder = useCallback(async () => {
    const requestId = ++navigationRequestRef.current;
    try {
      if (isElectronHost()) {
        const info = await getDocBlocksHost().workspaces.pickFolder();
        if (!info) return; // user cancelled
        if (requestId !== navigationRequestRef.current) return;
        const descriptor: WorkspaceDescriptor = {
          id: info.id,
          name: info.name,
          type: 'electron-native',
          rootPath: info.rootPath,
          lastOpened: new Date().toISOString(),
        };
        await saveWorkspace(descriptor);
        if (requestId !== navigationRequestRef.current) return;
        const provider = await createElectronFileSystemProvider(info.id, info.name, info.rootPath);
        if (!(await transitionAwayFromDocument(requestId))) return;
        setProvider(provider);
        setActiveWorkspaceId(descriptor.id);
        setSelectedFile(null);
        setSelectedFolder(null);
        setFolderEntries([]);
        pushHash(descriptor.id, null);
        return;
      }

      const nativeProvider = await (await loadNativeFileSystem()).openNativeFolder();
      if (requestId !== navigationRequestRef.current) return;
      const descriptor: WorkspaceDescriptor = {
        id: nativeProvider.id,
        name: nativeProvider.label,
        type: 'native',
        lastOpened: new Date().toISOString(),
      };
      await saveWorkspace(descriptor);
      if (requestId !== navigationRequestRef.current) return;
      if (!(await transitionAwayFromDocument(requestId))) return;
      setProvider(nativeProvider);
      setActiveWorkspaceId(descriptor.id);
      setSelectedFile(null);
      setSelectedFolder(null);
      setFolderEntries([]);
      pushHash(descriptor.id, null);
    } catch {
      // User cancelled or API not supported
    }
  }, [pushHash, transitionAwayFromDocument]);

  // A clone finished: the host already registered + persisted the folder,
  // so opening it mirrors the pickFolder success path exactly.
  const handleWorkspaceCloned = useCallback(
    (info: ElectronWorkspaceInfo) => {
      const requestId = ++navigationRequestRef.current;
      void (async () => {
        const descriptor: WorkspaceDescriptor = {
          id: info.id,
          name: info.name,
          type: 'electron-native',
          rootPath: info.rootPath,
          lastOpened: new Date().toISOString(),
        };
        await saveWorkspace(descriptor);
        if (requestId !== navigationRequestRef.current) return;
        const cloneProvider = await createElectronFileSystemProvider(
          info.id,
          info.name,
          info.rootPath,
        );
        if (!(await transitionAwayFromDocument(requestId))) return;
        setProvider(cloneProvider);
        setActiveWorkspaceId(descriptor.id);
        setSelectedFile(null);
        setSelectedFolder(null);
        setFolderEntries([]);
        pushHash(descriptor.id, null);
      })();
    },
    [pushHash, transitionAwayFromDocument],
  );

  const handleNewFile = useCallback(async () => {
    if (!provider) return;
    const name = await promptForText({
      title: 'New document',
      label: 'Document name',
      initialValue: 'Untitled.md',
      confirmLabel: 'Create',
    });
    if (!name) return;
    const filename = /\.[a-zA-Z0-9]+$/.test(name) ? name : `${name}.md`;
    const path = '/' + filename;
    const content = '# ' + filename.replace(/\.[^.]+$/, '') + '\n';
    const requestId = ++navigationRequestRef.current;
    try {
      const transitioned = await documentSession.transitionWithLoad(async () => {
        if (requestId !== navigationRequestRef.current) return null;
        const providerV2 = getFileSystemProviderV2(provider);
        if (providerV2) {
          try {
            await writeProviderText(provider, path, content, 'create');
          } catch (error: unknown) {
            if (error instanceof FsError && error.code === 'already-exists') {
              throw new Error('A document with that name already exists.');
            }
            throw error;
          }
        } else if (provider.commitFile) {
          const result = await provider.commitFile(path, content, null);
          if (result.status === 'conflict') {
            throw new Error('A document with that name already exists.');
          }
        } else {
          if (await providerEntryExists(provider, path)) {
            throw new Error('A document with that name already exists.');
          }
          await writeProviderText(provider, path, content);
        }
        if (requestId !== navigationRequestRef.current) return null;
        return {
          target: createDocumentTarget(provider, activeWorkspaceId ?? provider.id, path),
          content,
        };
      });
      if (!transitioned) return;
    } catch (error: unknown) {
      showToast('error', error instanceof Error ? error.message : 'Could not create the document.');
      return;
    }
    setSelectedFile(path);
    setInitialView('wysiwyg');
    setInitialSharedMode(null);
    setExplorerKey((k) => k + 1);
    closeWelcomeGateway();
    if (activeWorkspaceId) {
      pushHash(activeWorkspaceId, '/' + filename);
    }
  }, [
    provider,
    activeWorkspaceId,
    pushHash,
    closeWelcomeGateway,
    createDocumentTarget,
    documentSession,
    promptForText,
    showToast,
  ]);

  const handleNewFolder = useCallback(async () => {
    if (!provider) return;
    const name = await promptForText({
      title: 'New folder',
      label: 'Folder name',
      initialValue: 'Untitled folder',
      confirmLabel: 'Create',
    });
    if (!name) return;
    const folderName = name.trim();
    if (!folderName || /[\\/]/.test(folderName)) {
      showToast('error', 'Use a folder name without slashes.');
      return;
    }
    const path = `/${folderName}`;
    try {
      const providerV2 = getFileSystemProviderV2(provider);
      if (providerV2) {
        await providerV2.createDirectory(parseWorkspacePath(path), { mode: 'create' });
      } else {
        if (await providerEntryExists(provider, path)) {
          throw new Error('A file or folder with that name already exists.');
        }
        await provider.createDirectory(path);
      }
    } catch (error: unknown) {
      const message =
        error instanceof FsError && error.code === 'already-exists'
          ? 'A file or folder with that name already exists.'
          : error instanceof Error
            ? error.message
            : 'Could not create the folder.';
      showToast('error', message);
      return;
    }
    setSelectedFile(null);
    setSelectedFolder(path);
    setFolderEntries([]);
    setExplorerKey((key) => key + 1);
    closeWelcomeGateway();
    if (activeWorkspaceId) pushHash(activeWorkspaceId, null);
    if (effectiveCompact) setMobileShowEditor(true);
  }, [
    provider,
    promptForText,
    showToast,
    closeWelcomeGateway,
    activeWorkspaceId,
    pushHash,
    effectiveCompact,
  ]);

  // Manifest shortcut "New document" launches `/?action=new` (installed
  // PWA jump list). Handled once the first workspace/provider is ready,
  // then stripped from the URL so a reload doesn't re-trigger it.
  const actionNewHandledRef = useRef(false);
  useEffect(() => {
    if (!provider || actionNewHandledRef.current) return;
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') !== 'new') return;
    actionNewHandledRef.current = true;
    params.delete('action');
    const query = params.toString();
    window.history.replaceState(
      null,
      '',
      window.location.pathname + (query ? `?${query}` : '') + window.location.hash,
    );
    void handleNewFile();
  }, [provider, handleNewFile]);

  const handleRevealWorkspace = useCallback(async () => {
    if (!isElectronHost() || !activeWorkspaceId) return;
    const ws = await getWorkspace(activeWorkspaceId);
    if (ws?.type === 'electron-native' && ws.rootPath) {
      await getDocBlocksHost().shell.revealInFolder(ws.id);
    }
  }, [activeWorkspaceId]);

  // Subscribe to native menu commands (Electron host).
  useEffect(() => {
    if (!isElectronHost()) return;
    const host = getDocBlocksHost();
    return host.onMenuCommand((cmd) => {
      switch (cmd) {
        case 'file:new':
          handleNewFile();
          break;
        case 'file:openFolder':
          handleOpenFolder();
          break;
        case 'file:revealWorkspace':
          handleRevealWorkspace();
          break;
        case 'git:commit':
          if (gitRef.current.repo) gitRef.current.openDialog({ kind: 'commit' });
          break;
        case 'git:push':
          if (gitRef.current.repo) void gitRef.current.push();
          break;
        case 'git:pull':
          if (gitRef.current.repo) void gitRef.current.pull();
          break;
        case 'git:fetch':
          if (gitRef.current.repo) void gitRef.current.fetchRemote();
          break;
        case 'git:newBranch':
          if (gitRef.current.repo) {
            gitRef.current.openDialog({ kind: 'branches', createFocus: true });
          }
          break;
        case 'git:switchBranch':
          if (gitRef.current.repo) gitRef.current.openDialog({ kind: 'branches' });
          break;
        case 'git:history':
          if (gitRef.current.repo) gitRef.current.openDialog({ kind: 'history' });
          break;
        case 'git:clone':
          if (gitRef.current.available) gitRef.current.openDialog({ kind: 'clone' });
          break;
        case 'git:openOnRemote':
          gitRef.current.openOnRemote();
          break;
        case 'git:createPullRequest':
          if (gitRef.current.repo) void gitRef.current.createPullRequest();
          break;
        case 'help:viewOnGitHub':
          host.shell.openExternal('https://github.com/bendyline/docblocks');
          break;
        case 'help:checkForUpdates':
          host.updater.checkForUpdates().catch(() => {
            // errors surface via updater.onStatus
          });
          break;
        case 'help:about':
          void (async () => {
            const version = await host.updater.getVersion();
            // Deliberately a dialog, not a toast: the user asked to see this
            // and a version string they cannot read twice is useless.
            await acknowledge({ title: 'About DocBlocks', message: `DocBlocks ${version}` });
          })();
          break;
        default:
          break;
      }
    });
  }, [handleNewFile, handleOpenFolder, handleRevealWorkspace, acknowledge]);

  // OS open-file / deep-link handling lives after the container helpers it
  // depends on -- see the `openTransient` + onOpenRequest effect below.

  const handleSelect = useCallback(
    async (path: string, kind: 'file' | 'directory') => {
      if (!provider || !activeWorkspaceId) return;
      const requestId = ++navigationRequestRef.current;

      if (kind === 'directory') {
        if (!(await transitionAwayFromDocument(requestId))) return;
        if (requestId !== navigationRequestRef.current) return;
        setSelectedFile(null);
        setSelectedFolder(path);
        const entries = await readProviderDirectory(provider, path);
        if (requestId !== navigationRequestRef.current) return;
        setFolderEntries(entries);
        pushHash(activeWorkspaceId, null);
      } else {
        let content: string | null = null;
        try {
          const transitioned = await documentSession.transitionWithLoad(async () => {
            if (requestId !== navigationRequestRef.current) return null;
            content = await readProviderText(provider, path);
            if (requestId !== navigationRequestRef.current || content === null) return null;
            return {
              target: createDocumentTarget(provider, activeWorkspaceId, path),
              content,
            };
          });
          if (!transitioned) return;
        } catch (error: unknown) {
          showToast(
            'error',
            error instanceof Error ? error.message : 'Could not switch documents.',
          );
          return;
        }
        if (requestId !== navigationRequestRef.current) return;
        setSelectedFile(path);
        setSelectedFolder(null);
        setFolderEntries([]);
        setInitialView('wysiwyg');
        setInitialSharedMode(null);
        closeWelcomeGateway();
        pushHash(activeWorkspaceId, path);
        saveLastState({ workspaceId: activeWorkspaceId, filePath: path, view: 'wysiwyg' });
        if (effectiveCompact) setMobileShowEditor(true);
      }
    },
    [
      provider,
      activeWorkspaceId,
      pushHash,
      effectiveCompact,
      closeWelcomeGateway,
      createDocumentTarget,
      documentSession,
      transitionAwayFromDocument,
      showToast,
    ],
  );

  const handleEditorLinkClick = useCallback(
    (href: string): boolean => {
      const target = resolveShellEditorLinkTarget(href, selectedFile);
      if (!target) {
        showToast(
          'error',
          'DocBlocks only opens HTTP(S) links or Markdown files inside this workspace.',
        );
        return true;
      }
      if (target.kind === 'fragment') return false;

      if (target.kind === 'external') {
        if (isElectronHost()) {
          void getDocBlocksHost()
            .shell.openExternal(target.url)
            .catch((error: unknown) => {
              showToast(
                'error',
                error instanceof Error ? error.message : 'Could not open the external link.',
              );
            });
        } else if (typeof window !== 'undefined') {
          try {
            window.open(target.url, '_blank', 'noopener,noreferrer');
          } catch (error: unknown) {
            showToast(
              'error',
              error instanceof Error ? error.message : 'Could not open the external link.',
            );
          }
        }
        return true;
      }

      void (async () => {
        if (!provider) return;
        try {
          if (!(await providerEntryExists(provider, target.path))) {
            showToast('error', 'The linked Markdown file was not found in this workspace.');
            return;
          }
          await handleSelect(target.path, 'file');
        } catch (error: unknown) {
          showToast(
            'error',
            error instanceof Error ? error.message : 'Could not open the linked Markdown file.',
          );
        }
      })();
      return true;
    },
    [handleSelect, provider, selectedFile, showToast],
  );

  const handleTreeMutation = useCallback<FileTreeMutationHandler>(
    async (change, mutate) => {
      if (!provider || !activeWorkspaceId || !selectedFile) {
        await mutate();
        return;
      }

      if (change.type === 'move') {
        const nextFile = relocateProviderPath(selectedFile, change.oldPath, change.newPath);
        if (nextFile !== selectedFile) {
          await documentSession.retarget(
            createDocumentTarget(provider, activeWorkspaceId, nextFile),
            mutate,
          );
          return;
        }
      }

      if (change.type === 'delete' && pathContains(change.path, selectedFile)) {
        await documentSession.delete(mutate);
        return;
      }

      await mutate();
    },
    [provider, activeWorkspaceId, selectedFile, documentSession, createDocumentTarget],
  );

  const handleTreeChange = useCallback(
    async (change?: FileTreeChange) => {
      if (!provider) return;
      setDocumentLinkEpoch((epoch) => epoch + 1);
      if (change?.type === 'move' && change.oldPath && change.newPath) {
        if (activeWorkspaceId) {
          setPinnedDocuments((current) =>
            relocatePinnedDocuments(current, activeWorkspaceId, change.oldPath, change.newPath),
          );
        }
        const nextFile = selectedFile
          ? relocateProviderPath(selectedFile, change.oldPath, change.newPath)
          : null;
        const nextFolder = selectedFolder
          ? relocateProviderPath(selectedFolder, change.oldPath, change.newPath)
          : null;

        if (nextFile !== selectedFile) {
          setSelectedFile(nextFile);
          if (activeWorkspaceId) {
            pushHash(activeWorkspaceId, nextFile);
            if (nextFile) {
              saveLastState({
                workspaceId: activeWorkspaceId,
                filePath: nextFile,
                view: 'wysiwyg',
              });
            }
          }
        }
        if (nextFolder !== selectedFolder) setSelectedFolder(nextFolder);
        if (nextFolder) setFolderEntries(await readProviderDirectory(provider, nextFolder));
        return;
      }

      if (change?.type === 'delete' && activeWorkspaceId) {
        for (const document of pinnedDocuments) {
          if (
            document.workspaceId === activeWorkspaceId &&
            pathContains(change.path, document.path)
          ) {
            setPinnedAvailability(document, 'missing');
          }
        }
      }

      // If the open file was deleted, clear the editor
      if (selectedFile) {
        const exists = await providerEntryExists(provider, selectedFile);
        if (!exists) {
          setSelectedFile(null);
          if (activeWorkspaceId) pushHash(activeWorkspaceId, null);
        }
      }
      if (selectedFolder) {
        const entries = await readProviderDirectory(provider, selectedFolder);
        setFolderEntries(entries);
      }
    },
    [
      provider,
      selectedFile,
      selectedFolder,
      activeWorkspaceId,
      pinnedDocuments,
      pushHash,
      setPinnedAvailability,
    ],
  );

  const acquirePinnedDocumentProvider = useCallback(
    async (document: PinnedDocument): Promise<PinnedDocumentProviderAccess> => {
      const workspace = await getWorkspace(document.workspaceId);
      if (!workspace) return { kind: 'missing-workspace' };
      if (activeWorkspaceId === workspace.id && provider) {
        return { kind: 'ready', workspace, provider, owned: false };
      }

      const transient = getTransientWorkspace(workspace.id);
      if (transient) {
        return { kind: 'ready', workspace, provider: transient.provider, owned: false };
      }

      let pinnedProvider: FileSystemProvider | null = null;
      if (workspace.type === 'electron-native') {
        pinnedProvider = isElectronHost()
          ? await createElectronProviderFromWorkspace(workspace)
          : null;
      } else if (workspace.type === 'native') {
        pinnedProvider = await (await loadNativeFileSystem()).restoreNativeFolder(workspace.id);
      } else {
        pinnedProvider = await createIndexedDbFileSystemProvider(workspace.id, workspace.name);
      }
      if (!pinnedProvider) return { kind: 'unavailable', workspace };
      return { kind: 'ready', workspace, provider: pinnedProvider, owned: true };
    },
    [activeWorkspaceId, provider],
  );

  const markRelocatedPinnedDocument = useCallback((document: PinnedDocument, newPath: string) => {
    const relocated: PinnedDocument = {
      workspaceId: document.workspaceId,
      workspaceName: document.workspaceName,
      path: newPath,
    };
    setPinnedDocuments((current) =>
      relocatePinnedDocuments(current, document.workspaceId, document.path, newPath),
    );
    setPinnedDocumentAvailability((current) => {
      const oldKey = pinnedDocumentKey(document);
      const nextKey = pinnedDocumentKey(relocated);
      const next = new Map(current);
      next.delete(oldKey);
      next.set(nextKey, 'available');
      return next;
    });
  }, []);

  const handlePinnedDocumentRename = useCallback(
    async (document: PinnedDocumentListItem) => {
      if (document.availability === 'missing') {
        await confirmMissingPinnedDocument(document);
        return;
      }

      const oldName = basenameOf(document.path);
      const response = await promptForText({
        title: 'Rename document',
        label: 'Document name',
        initialValue: oldName,
        confirmLabel: 'Rename',
      });
      if (response === null) return;
      const newName = response.trim();
      if (!newName || /[\\/]/.test(newName)) {
        showToast('error', 'Use a document name without slashes.');
        return;
      }

      const parent = dirnameOf(document.path);
      let newPath: string;
      try {
        newPath = parseWorkspacePath(parent ? `${parent}/${newName}` : newName);
      } catch {
        showToast('error', 'Use a valid document name.');
        return;
      }
      if (newPath === document.path) return;

      const access = await acquirePinnedDocumentProvider(document);
      if (access.kind === 'missing-workspace') {
        await confirmMissingPinnedDocument(document);
        return;
      }
      if (access.kind === 'unavailable') {
        setPinnedAvailability(document, 'unknown');
        showToast(
          'error',
          `DocBlocks could not open "${access.workspace.name}". Open that workspace and grant access, then try again.`,
        );
        return;
      }

      try {
        if (!(await pinnedProviderFileExists(access.provider, document.path))) {
          await confirmMissingPinnedDocument(document);
          return;
        }
        const change: FileTreeChange = {
          type: 'move',
          oldPath: document.path,
          newPath,
          kind: 'file',
        };
        const mutate = () => moveFileSystemEntry(access.provider, document.path, newPath, 'file');
        if (access.provider === provider && access.workspace.id === activeWorkspaceId) {
          await handleTreeMutation(change, mutate);
          await handleTreeChange(change);
          setExplorerKey((key) => key + 1);
        } else {
          await mutate();
        }
        markRelocatedPinnedDocument(document, newPath);
      } finally {
        if (access.owned) {
          try {
            await getFileSystemProviderV2(access.provider)?.dispose();
          } catch {
            // The rename result is authoritative; cleanup must not turn success into an error.
          }
        }
      }
    },
    [
      acquirePinnedDocumentProvider,
      activeWorkspaceId,
      confirmMissingPinnedDocument,
      handleTreeChange,
      handleTreeMutation,
      markRelocatedPinnedDocument,
      promptForText,
      provider,
      setPinnedAvailability,
      showToast,
    ],
  );

  const handlePinnedDocumentDelete = useCallback(
    async (document: PinnedDocumentListItem) => {
      if (document.availability === 'missing') {
        await confirmMissingPinnedDocument(document);
        return;
      }

      const access = await acquirePinnedDocumentProvider(document);
      if (access.kind === 'missing-workspace') {
        await confirmMissingPinnedDocument(document);
        return;
      }
      if (access.kind === 'unavailable') {
        setPinnedAvailability(document, 'unknown');
        showToast(
          'error',
          `DocBlocks could not open "${access.workspace.name}". Open that workspace and grant access, then try again.`,
        );
        return;
      }

      try {
        if (!(await pinnedProviderFileExists(access.provider, document.path))) {
          await confirmMissingPinnedDocument(document);
          return;
        }
        if (
          !(await confirmDeleteEntry(
            `Delete the document "${basenameOf(document.path)}"? This cannot be undone.`,
          ))
        ) {
          return;
        }

        const change: FileTreeChange = {
          type: 'delete',
          path: document.path,
          kind: 'file',
        };
        const mutate = async () => {
          if (!(await removePinnedProviderFile(access.provider, document.path))) {
            throw new Error('The document disappeared before it could be deleted.');
          }
        };
        if (access.provider === provider && access.workspace.id === activeWorkspaceId) {
          await handleTreeMutation(change, mutate);
          await handleTreeChange(change);
          setExplorerKey((key) => key + 1);
        } else {
          await mutate();
        }
        setPinnedAvailability(document, 'missing');
      } finally {
        if (access.owned) {
          try {
            await getFileSystemProviderV2(access.provider)?.dispose();
          } catch {
            // The delete result is authoritative; cleanup must not turn success into an error.
          }
        }
      }
    },
    [
      acquirePinnedDocumentProvider,
      activeWorkspaceId,
      confirmDeleteEntry,
      confirmMissingPinnedDocument,
      handleTreeChange,
      handleTreeMutation,
      provider,
      setPinnedAvailability,
      showToast,
    ],
  );

  /**
   * Copy non-markdown files from an imported container into the target
   * markdown file's `_files/` sibling folder, preserving the source's
   * relative structure.
   */
  const persistImportedMedia = useCallback(
    async (
      source: {
        listFiles(): Promise<Array<{ path: string; mimeType: string }>>;
        readFile(path: string): Promise<ArrayBuffer | null>;
      },
      target: FileSystemProvider,
      importedMarkdownPath: string,
    ) => {
      const parentDir = dirnameOf(importedMarkdownPath);
      const folder = basenameOf(importedMarkdownPath).replace(/\.[^.]+$/, '') + '_files';
      const mediaRoot = parentDir ? `${parentDir}/${folder}` : folder;
      const entries = await source.listFiles();
      const targetV2 = getFileSystemProviderV2(target);
      for (const entry of entries) {
        if (entry.path.endsWith('.md')) continue;
        const data = await source.readFile(entry.path);
        if (!data) continue;
        const cleanPath = entry.path.replace(/^\/+/, '');
        const destination = `${mediaRoot}/${cleanPath}`;
        if (targetV2) {
          await targetV2.writeFile(parseWorkspacePath(destination), data, {
            mode: 'upsert',
            createParents: true,
          });
        } else {
          await target.writeBinary(destination, data);
        }
      }
    },
    [],
  );

  const handleImportFiles = useCallback(
    async (files: File[]) => {
      if (!provider) return;
      const result = await importDroppedFiles(files, provider, {
        persistMedia: (source, path) => persistImportedMedia(source, provider, path),
      });
      // Refresh file tree so the new markdown files + _files folders show up.
      setExplorerKey((k) => k + 1);
      // A drop that failed used to be indistinguishable from no drop at all.
      const summary = summariseImport(result);
      if (summary) showToast(summary.kind, summary.message);
    },
    [provider, persistImportedMedia, showToast],
  );

  const handleEditorChange = useCallback(
    (source: string) => {
      if (!editorSessionScope) return;
      try {
        documentSession.edit(source, editorSessionScope);
      } catch {
        // A close/transition has frozen the session. Do not let a late editor
        // callback create view state that cannot be persisted.
      }
    },
    [documentSession, editorSessionScope],
  );

  const handleRenameWorkspace = useCallback(async () => {
    if (!activeWorkspaceId) return;
    const ws = await getWorkspace(activeWorkspaceId);
    if (!ws) return;
    const newName = await promptForText({
      title: 'Rename workspace',
      label: 'Workspace name',
      initialValue: ws.name,
      confirmLabel: 'Rename',
    });
    if (!newName || newName === ws.name) return;
    await saveWorkspace({ ...ws, name: newName });
    setPinnedDocuments((current) =>
      renamePinnedDocumentWorkspace(current, activeWorkspaceId, newName),
    );
    setDescriptorRefreshKey((key) => key + 1);
  }, [activeWorkspaceId, promptForText]);

  /**
   * Open a loose file or `.dbk` bundle delivered by the OS into a session-only
   * *transient* workspace backed by an in-memory provider. Loose files save
   * straight back to disk; bundles are re-zipped by the session commit target.
   */
  const openTransient = useCallback(
    async (
      req: Extract<OpenRequest, { kind: 'external-file' | 'external-bundle' }>,
      navigationRequestId: number,
    ) => {
      const isCurrent = () => navigationRequestId === navigationRequestRef.current;
      const host = getDocBlocksHost();
      const revokeAbandonedResource = () =>
        host.external.revoke(req.resourceId).catch(() => undefined);
      if (!isCurrent()) {
        await revokeAbandonedResource();
        return;
      }
      const id = `transient-${req.kind}-${req.resourceId}`;
      let mem: MemoryFileSystemProvider;
      try {
        mem = await createMemoryFileSystemProvider(id, req.name);
      } catch (error: unknown) {
        await revokeAbandonedResource();
        throw error;
      }
      if (!isCurrent()) {
        await getFileSystemProviderV2(mem)?.dispose();
        await revokeAbandonedResource();
        return;
      }
      let primaryFile: string;
      let origin: WorkspaceDescriptor['origin'];
      let adoptionStarted = false;
      let opened = false;

      try {
        if (req.kind === 'external-file') {
          const content = await host.external.readText(req.resourceId);
          if (content === null) {
            throw new Error('The external file is no longer available.');
          }
          if (!isCurrent()) return;
          primaryFile = req.name; // e.g. "notes.md"
          mem.seedText(primaryFile, content);
          origin = { kind: 'loose-file', resourceId: req.resourceId };
        } else {
          const bytes = await host.external.readBinary(req.resourceId);
          if (!bytes) {
            throw new Error('The external bundle is no longer available.');
          }
          if (!isCurrent()) return;
          const version = await sha256Hex(bytes);
          if (!isCurrent()) return;
          const base = req.name.replace(/\.[^.]+$/, '');
          primaryFile = `${base}.md`;
          const snapshot = await decodeDbkWorkspace(bytes, {
            targetDocumentPath: primaryFile,
          });
          if (!isCurrent()) return;
          mem.replaceContents(snapshot);
          origin = { kind: 'dbk', resourceId: req.resourceId, version };
        }

        adoptionStarted = true;
        opened = await adoptTransientWorkspace({
          id,
          name: req.name,
          provider: mem,
          primaryFile,
          origin,
          push: true,
          navigationRequestId,
        });
      } finally {
        try {
          if (!adoptionStarted) {
            await getFileSystemProviderV2(mem)?.dispose();
          }
        } finally {
          if (!opened) await revokeAbandonedResource();
        }
      }
    },
    [adoptTransientWorkspace],
  );

  // Subscribe to OS open-file / deep-link requests.
  useEffect(() => {
    if (!isElectronHost()) return;
    const host = getDocBlocksHost();
    return host.onOpenRequest((req) => {
      // Claim the navigation when the OS request arrives, before any external
      // file read or bundle decoding. A slower older request can no longer
      // finish after and replace a newer document.
      const requestId = ++navigationRequestRef.current;
      void (
        req.kind === 'workspace-file'
          ? workspaceAuthorityBarrier.wait().then(() => {
              if (requestId !== navigationRequestRef.current) return null;
              return openFromIds(req.workspaceId, req.path, true, undefined, requestId).then(
                (opened) => {
                  if (!opened && requestId === navigationRequestRef.current) {
                    throw new Error('The requested workspace file is no longer available.');
                  }
                  return opened;
                },
              );
            })
          : openTransient(req, requestId)
      ).catch((error: unknown) => {
        if (requestId !== navigationRequestRef.current) return;
        showToast(
          'error',
          error instanceof Error
            ? 'DocBlocks could not open the requested file: ' + error.message
            : 'DocBlocks could not open the requested file.',
        );
      });
    });
  }, [openFromIds, openTransient, workspaceAuthorityBarrier, showToast]);

  /**
   * Web counterpart of `openTransient`: a `.md` or `.dbk` launched into the
   * installed PWA (File Handling API) arrives as a FileSystemFileHandle.
   * Contents are seeded into the same session-only in-memory workspace;
   * saves write back through the handle (see `createDocumentTarget`).
   */
  const openTransientFromHandle = useCallback(
    async (handle: FileSystemFileHandle) => {
      const name = handle.name;
      const isBundle = /\.(dbk|zip)$/i.test(name);
      // Keyed by file name: relaunching the same file replaces the registry
      // entry instead of piling up session workspaces. Two different files
      // that share a name would collide -- acceptable for session-only state.
      const id = `transient-web-${isBundle ? 'bundle' : 'file'}-${name}`;
      // Ask for write access while the OS-launch user activation is fresh so
      // autosave doesn't have to prompt mid-typing. Best-effort: a denial
      // surfaces on save, not on open.
      await ensureHandleWritePermission(handle);
      const mem = await createMemoryFileSystemProvider(id, name);
      const file = await handle.getFile();
      let primaryFile: string;
      let origin: WorkspaceDescriptor['origin'];
      let adoptionStarted = false;

      try {
        if (!isBundle) {
          primaryFile = name;
          mem.seedText(primaryFile, await file.text());
          origin = { kind: 'web-file', handle, name };
        } else {
          const bytes = await file.arrayBuffer();
          const version = await sha256Hex(bytes);
          const base = name.replace(/\.[^.]+$/, '');
          primaryFile = `${base}.md`;
          const snapshot = await decodeDbkWorkspace(bytes, {
            targetDocumentPath: primaryFile,
          });
          mem.replaceContents(snapshot);
          origin = { kind: 'web-dbk', handle, name, version };
        }

        adoptionStarted = true;
        await adoptTransientWorkspace({
          id,
          name,
          provider: mem,
          primaryFile,
          origin,
          push: true,
        });
      } finally {
        if (!adoptionStarted) await getFileSystemProviderV2(mem)?.dispose();
      }
    },
    [adoptTransientWorkspace],
  );

  // Consume files the OS delivers to the installed PWA (Chromium desktop).
  // launchQueue buffers launch params until a consumer is set, so a
  // post-mount effect is early enough to catch the launching file.
  useEffect(() => {
    if (isElectronHost() || typeof window === 'undefined') return;
    const launchQueue = window.launchQueue;
    if (!launchQueue) return;
    launchQueue.setConsumer((params) => {
      if (params.files.length === 0) return;
      const handle = params.files[0];
      void openTransientFromHandle(handle).catch((error: unknown) => {
        showToast(
          'error',
          error instanceof Error
            ? 'DocBlocks could not open the launched file: ' + error.message
            : 'DocBlocks could not open the launched file.',
        );
      });
    });
  }, [openTransientFromHandle, showToast]);

  const updateStatusBarVisible =
    viewPreferences.showStatusBar === true && selectedFile !== null && mediaProvider !== null;

  const handleDownloadWorkspace = useCallback(async () => {
    if (!provider) return;
    try {
      await documentSession.flush('backup');
      const [{ MemoryContentContainer }, { containerToZip }] = await Promise.all([
        import('@bendyline/squisq/storage'),
        import('@bendyline/squisq-formats/container'),
      ]);

      const container = new MemoryContentContainer();
      await copyProviderToContainer(provider, container, '');

      const blob = await containerToZip(container);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName =
        (provider.label || 'workspace').replace(/[^a-z0-9_\- ]/gi, '_').trim() || 'workspace';
      a.download = `${safeName}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to download workspace', err);
      showToast('error', 'Failed to download workspace. See console for details.');
    }
  }, [provider, documentSession, showToast]);

  /**
   * Bundle every workspace the host can open without further prompting
   * into a single zip, with each workspace nested under its own folder.
   * Native (browser-picked) workspaces whose handle hasn't been re-granted
   * for this session are skipped -- restoring them would require a user
   * gesture per workspace.
   */
  const handleDownloadAllWorkspaces = useCallback(async () => {
    try {
      await documentSession.flush('backup');
      const [{ MemoryContentContainer }, { containerToZip }] = await Promise.all([
        import('@bendyline/squisq/storage'),
        import('@bendyline/squisq-formats/container'),
      ]);

      const electron = isElectronHost();
      const all = await listWorkspaces();
      const candidates = all.filter((w) =>
        electron
          ? w.type === 'electron-native' || w.type === 'transient'
          : w.type !== 'electron-native',
      );
      if (candidates.length === 0) {
        showToast('error', 'No workspaces to download.');
        return;
      }

      const container = new MemoryContentContainer();
      const usedFolders = new Set<string>();
      const skipped: string[] = [];

      for (const ws of candidates) {
        let p: FileSystemProvider | null = null;
        let ownsProvider = false;
        try {
          const transient = getTransientWorkspace(ws.id);
          if (transient) {
            p = transient.provider;
          } else if (ws.type === 'electron-native') {
            p = await createElectronProviderFromWorkspace(ws);
            ownsProvider = p !== null;
          } else if (ws.type === 'native') {
            // Restore without prompting -- only succeeds when the browser
            // still remembers the granted handle for this origin/session.
            p = await (await loadNativeFileSystem()).restoreNativeFolder(ws.id);
            ownsProvider = p !== null;
          } else {
            p = await createIndexedDbFileSystemProvider(ws.id, ws.name);
            ownsProvider = true;
          }
        } catch (err) {
          console.warn(`Skipping workspace ${ws.name}:`, err);
        }

        if (!p) {
          skipped.push(ws.name);
          continue;
        }

        // Pick a unique, filesystem-safe folder name per workspace.
        const base = (ws.name || 'workspace').replace(/[^a-z0-9_\- ]/gi, '_').trim() || 'workspace';
        let folder = base;
        let suffix = 2;
        while (usedFolders.has(folder)) {
          folder = `${base} (${suffix++})`;
        }
        usedFolders.add(folder);

        try {
          await copyProviderToContainer(p, container, folder);
        } finally {
          if (ownsProvider) await getFileSystemProviderV2(p)?.dispose();
        }
      }

      if (usedFolders.size === 0) {
        showToast('error', 'No workspaces could be opened for download.');
        return;
      }

      const blob = await containerToZip(container);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 10);
      a.download = `docblocks-workspaces-${stamp}.zip`;
      a.click();
      URL.revokeObjectURL(url);

      if (skipped.length > 0) {
        // A dialog, not a toast: this names workspaces the user now has to go
        // re-grant one by one. A list you must act on cannot expire in 3s.
        await acknowledge({
          title: 'Some workspaces were skipped',
          message: `Downloaded ${usedFolders.size} workspace(s). Skipped ${skipped.length} that require re-granting access: ${skipped.join(', ')}.`,
        });
      }
    } catch (err) {
      console.error('Failed to download all workspaces', err);
      showToast('error', 'Failed to download all workspaces. See console for details.');
    }
  }, [documentSession, acknowledge, showToast]);

  const handleKeepBrowserData = useCallback(async () => {
    if (typeof navigator === 'undefined') return;

    // Every outcome here that ends in "back up your documents" is a dialog:
    // it is standing advice about the durability of the user's work, and a
    // toast that evaporates in 3s is the wrong channel for it. The one
    // outcome that asks nothing of the user -- storage is already persistent
    // -- is a plain success toast.
    const storage = navigator.storage;
    if (!storage || typeof storage.persist !== 'function') {
      await acknowledge({
        title: 'Persistent storage unavailable',
        message:
          'This browser does not support persistent storage requests. Please back up browser docs frequently.',
      });
      return;
    }

    try {
      const alreadyPersistent =
        typeof storage.persisted === 'function' ? await storage.persisted() : false;
      if (alreadyPersistent) {
        setBrowserStoragePersistent(true);
        showToast('success', 'DocBlocks browser data is already marked as persistent.');
        return;
      }

      const granted = await storage.persist();
      if (granted) {
        setBrowserStoragePersistent(true);
        await acknowledge({
          title: 'Storage will be kept for longer',
          message:
            'This browser will try to keep DocBlocks data for longer. Please still back up browser docs frequently.',
        });
      } else {
        await acknowledge({
          title: 'Storage request declined',
          message:
            'The browser did not grant permanent storage for DocBlocks. Please try again in a day or two. Meanwhile, please back up browser documents frequently.',
        });
      }
    } catch {
      await acknowledge({
        title: 'Storage request failed',
        message:
          'DocBlocks could not request persistent browser storage. Please back up browser docs frequently.',
      });
    }
  }, [acknowledge, showToast]);

  // Settings dialog "Storage" row (browser surface): usage/quota estimate.
  const getBrowserStorageEstimate = useCallback(async () => {
    if (typeof navigator === 'undefined') return null;
    const storage = navigator.storage;
    if (!storage || typeof storage.estimate !== 'function') return null;
    try {
      const { usage, quota } = await storage.estimate();
      if (typeof usage !== 'number' || typeof quota !== 'number') return null;
      return { usage, quota };
    } catch {
      return null;
    }
  }, []);

  const handleRemoveWorkspace = useCallback(async () => {
    if (!activeWorkspaceId) return;
    const ws = await getWorkspace(activeWorkspaceId);
    // Only a browser-local workspace's documents are DocBlocks' to destroy.
    // Folder-backed workspaces (Electron or File System Access) keep their
    // files on the user's disk, so promising the removal is irreversible there
    // would be a lie in the more alarming direction.
    const destroysDocuments = ws?.type === 'indexeddb';
    const confirmed = await confirmAction({
      title: 'Remove workspace',
      message: destroysDocuments
        ? 'Remove this workspace? Its documents will be permanently deleted.'
        : 'Remove this workspace from DocBlocks? The files on disk will not be deleted.',
      confirmLabel: 'Remove',
      // Only the browser-local case actually destroys the user's documents.
      destructive: destroysDocuments,
    });
    if (!confirmed) return;
    // No request-id re-check is needed across this await: unlike the native
    // confirm() it replaces, nothing above claimed a navigation. The id is
    // still taken *after* the user answers, so a navigation that happened
    // while the dialog was open is the one this request supersedes -- exactly
    // the ordering the synchronous version had.
    const requestId = ++navigationRequestRef.current;
    if (!(await transitionAwayFromDocument(requestId))) return;

    if (ws?.type === 'electron-native') {
      try {
        await getDocBlocksHost().workspaces.unregister(activeWorkspaceId);
      } catch {
        // ignore -- host cleanup is best-effort
      }
    } else if (ws?.type === 'transient') {
      const origin = ws.origin;
      if (isElectronHost() && origin && (origin.kind === 'loose-file' || origin.kind === 'dbk')) {
        try {
          await getDocBlocksHost().external.revoke(origin.resourceId);
        } catch {
          // Navigation/destruction also revokes the capability; removal is best effort.
        }
      }
    } else if (ws?.type === 'native') {
      await (await loadNativeFileSystem()).removeDirectoryHandle(activeWorkspaceId);
    } else if (ws?.type === 'indexeddb') {
      // A browser-local workspace's documents live in a DocBlocks-owned
      // IndexedDB database. Dropping only the descriptor would strand them:
      // invisible to the user, still charged against the origin quota, and
      // ready to reappear the moment a workspace reuses this id -- which
      // `ensureDefaultWorkspace` does on the very next launch for 'default'.
      await (await loadIndexedDbFileSystem()).deleteIndexedDBWorkspaceData(activeWorkspaceId);
    }
    await removeWorkspace(activeWorkspaceId);
    for (const document of pinnedDocuments) {
      if (document.workspaceId === activeWorkspaceId) {
        setPinnedAvailability(document, 'missing');
      }
    }
    if (requestId !== navigationRequestRef.current) return;

    const electron = isElectronHost();
    // Switch to most recent remaining workspace or create default
    const remaining = (await listWorkspaces()).filter((w) =>
      electron ? w.type === 'electron-native' : w.type !== 'electron-native',
    );
    if (remaining.length > 0) {
      const next = remaining[0];
      await handleWorkspaceSelect(next);
    } else if (electron) {
      const info = await getDocBlocksHost().workspaces.getDefault();
      const descriptor: WorkspaceDescriptor = {
        id: info.id,
        name: info.name,
        type: 'electron-native',
        rootPath: info.rootPath,
        lastOpened: new Date().toISOString(),
      };
      await saveWorkspace(descriptor);
      const p = await createElectronFileSystemProvider(info.id, info.name, info.rootPath);
      setProvider(p);
      setActiveWorkspaceId(info.id);
      setSelectedFile(null);
      setSelectedFolder(null);
      setFolderEntries([]);
    } else {
      const defaultWs = await ensureDefaultWorkspace();
      const fsProvider = await createIndexedDbFileSystemProvider(defaultWs.id, defaultWs.name);
      setProvider(fsProvider);
      setActiveWorkspaceId(defaultWs.id);
      setSelectedFile(null);
      setSelectedFolder(null);
      setFolderEntries([]);
    }
  }, [
    activeWorkspaceId,
    confirmAction,
    handleWorkspaceSelect,
    pinnedDocuments,
    setPinnedAvailability,
    transitionAwayFromDocument,
  ]);

  return (
    <div
      className={`db-shell${effectiveCompact ? ' db-shell--mobile' : ''}`}
      data-theme={resolvedTheme}
      data-accent={accentColor}
      data-document-status={documentSnapshot.status}
    >
      <GitContext.Provider value={git}>
        {promptDialog}
        {confirmDialog}
        {workspaceStartupError && (
          <div className="db-save-toast db-save-toast--error" role="alert" aria-live="assertive">
            {workspaceStartupError}
          </div>
        )}
        {saveToast && (
          <div
            className={'db-save-toast db-save-toast--' + saveToast.kind}
            role={saveToast.kind === 'error' ? 'alert' : 'status'}
            aria-live={saveToast.kind === 'error' ? 'assertive' : 'polite'}
          >
            {saveToast.message}
          </div>
        )}
        {offlineReadyToast && !saveToast && (
          <div className="db-save-toast db-save-toast--success" role="status" aria-live="polite">
            DocBlocks is ready to work offline.
          </div>
        )}
        {documentSnapshot.conflict && (
          <div className="db-document-conflict" role="alert">
            <span>
              This document changed outside DocBlocks. Your unsaved version is still intact.
            </span>
            <div className="db-document-conflict-actions">
              <button type="button" onClick={() => void handleKeepLocalDocument()}>
                Keep mine
              </button>
              <button type="button" onClick={() => void handleUseExternalDocument()}>
                Reload external
              </button>
            </div>
          </div>
        )}
        {storageFull && !documentSnapshot.conflict && (
          <div className="db-storage-full-banner" role="alert">
            <span>
              Browser storage is full -- changes can&rsquo;t be saved. Free up space or back up your
              work now.
            </span>
            <div className="db-storage-full-banner-actions">
              <button type="button" onClick={() => void handleDownloadAllWorkspaces()}>
                Download all workspaces
              </button>
              <button type="button" onClick={() => setStorageFull(false)}>
                Dismiss
              </button>
            </div>
          </div>
        )}
        {workspaceSettingsOpen && activeWorkspaceDescriptor && (
          <WorkspaceSettingsDialog
            workspace={activeWorkspaceDescriptor}
            globalVersioningPreference={versioningPreference}
            onChange={handleWorkspaceVersioningOverrideChange}
            onClose={() => setWorkspaceSettingsOpen(false)}
          />
        )}
        {/* Main area */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Left sidebar -- hidden in compact layout when the editor is
            showing (compact = real mobile narrow viewport OR the user
            dragged the resizer below SIDEBAR_COLLAPSE_THRESHOLD). */}
          {(!effectiveCompact || !mobileShowEditor) && (
            <aside
              ref={sidebarRef}
              className="db-shell-sidebar"
              aria-label="Workspace and files"
              style={effectiveCompact ? undefined : { width: `${sidebarWidth}px` }}
            >
              <div className="db-shell-sidebar-header">
                <AppMenu
                  logoUrl={logoUrl}
                  themePreference={themePreference}
                  onThemeChange={handleThemeChange}
                  accentColor={accentColor}
                  onAccentColorChange={handleAccentColorChange}
                  writeCanvasSettings={writeCanvasSettings}
                  onWriteCanvasSettingsChange={handleWriteCanvasSettingsChange}
                  versioningPreference={versioningPreference}
                  onVersioningPreferenceChange={handleVersioningPreferenceChange}
                  onDownloadAllWorkspaces={handleDownloadAllWorkspaces}
                  onKeepBrowserData={
                    showBrowserStorageWarning && !browserStoragePersistent
                      ? handleKeepBrowserData
                      : undefined
                  }
                  onInstallApp={installPromptEvent ? handleInstallApp : undefined}
                  getStorageEstimate={
                    showBrowserStorageWarning ? getBrowserStorageEstimate : undefined
                  }
                  storagePersistent={
                    showBrowserStorageWarning ? browserStoragePersistent : undefined
                  }
                  appVersion={appVersion}
                  appBuildDate={appBuildDate}
                />
                <WorkspacePicker
                  activeWorkspaceId={activeWorkspaceId}
                  refreshKey={descriptorRefreshKey}
                  onSelect={handleWorkspaceSelect}
                  onOpenFolder={handleOpenFolder}
                  onCloneRepository={
                    git.available ? () => git.openDialog({ kind: 'clone' }) : undefined
                  }
                />
                <WorkspaceSettingsButton
                  onSettings={handleOpenWorkspaceSettings}
                  onRename={handleRenameWorkspace}
                  onDownload={handleDownloadWorkspace}
                  onRemove={handleRemoveWorkspace}
                />
                {compactLayout && !isMobile && (
                  <button
                    className="db-restore-split"
                    onClick={() => setCompactLayout(false)}
                    aria-label="Restore split view"
                    title="Restore split view"
                  >
                    <SplitViewIcon />
                  </button>
                )}
                <span className={'db-window-drag-grip'} aria-hidden={true} />
              </div>
              {git.available && (
                <Suspense fallback={null}>
                  <GitUI
                    onOpenFile={(path) => void handleSelect(path, 'file')}
                    onWorkspaceCloned={handleWorkspaceCloned}
                  />
                </Suspense>
              )}
              <FileExplorer
                key={explorerKey}
                provider={provider}
                activeWorkspaceId={activeWorkspaceId}
                activeFilePath={selectedFile}
                pinnedDocuments={pinnedDocumentItems}
                pinnedPaths={activeWorkspacePinnedPaths}
                onPinnedDocumentSelect={(document) => void handlePinnedDocumentSelect(document)}
                onPinnedDocumentUnpin={unpinDocument}
                onPinnedDocumentRename={handlePinnedDocumentRename}
                onPinnedDocumentDelete={handlePinnedDocumentDelete}
                onTogglePin={handleTogglePin}
                onSelect={handleSelect}
                onTreeMutation={handleTreeMutation}
                onTreeChange={handleTreeChange}
                onImportFiles={handleImportFiles}
                confirmDelete={confirmDeleteEntry}
                moveDestinations={
                  activeWorkspaceDescriptor?.type === 'transient'
                    ? transientMoveDestinations
                    : undefined
                }
                onMoveToWorkspace={
                  activeWorkspaceDescriptor?.type === 'transient'
                    ? handleMoveTransientWorkspace
                    : undefined
                }
              />
              {isMobile && showWelcomeGateway && (
                <section
                  className="db-mobile-first-run"
                  aria-labelledby="db-mobile-first-run-title"
                >
                  <p className="db-mobile-first-run-eyebrow">Local-first Markdown editor</p>
                  <h1 id="db-mobile-first-run-title">Welcome to DocBlocks</h1>
                  <p>
                    Write visually, keep plain Markdown underneath, and export the same document in
                    useful formats. Your browser workspace stays on this device.
                  </p>
                  <div className="db-mobile-first-run-actions">
                    <button
                      type="button"
                      onClick={() => {
                        closeWelcomeGateway();
                        setMobileShowEditor(true);
                      }}
                    >
                      Tour the welcome document
                    </button>
                    <button
                      type="button"
                      className="db-mobile-first-run-secondary"
                      onClick={() => void handleNewFile()}
                    >
                      Create a document
                    </button>
                  </div>
                </section>
              )}
              <div className="db-shell-sidebar-footer">
                <a href="https://docblocks.com/docs/" target="_blank" rel="noopener noreferrer">
                  Docs
                </a>
                <span className="db-shell-sidebar-footer-separator" aria-hidden="true">
                  &bull;
                </span>
                <a href="https://docblocks.com/terms/" target="_blank" rel="noopener noreferrer">
                  Terms
                </a>
                <span className="db-shell-sidebar-footer-separator" aria-hidden="true">
                  &bull;
                </span>
                <a href={issueReportUrl} target="_blank" rel="noopener noreferrer">
                  Report issue
                </a>
                {showBrowserStorageWarning && (
                  <>
                    <span className="db-shell-sidebar-footer-separator" aria-hidden="true">
                      &bull;
                    </span>
                    <button
                      type="button"
                      className="db-shell-sidebar-footer-action"
                      onClick={() => void handleDownloadAllWorkspaces()}
                      title="Browser documents can be removed automatically. Download all workspaces now."
                    >
                      Back up browser docs
                    </button>
                  </>
                )}
              </div>
            </aside>
          )}

          {/* Resize handle between sidebar and editor -- hidden whenever
            the layout is compact (no sidebar to resize). */}
          {!effectiveCompact && (
            <div
              className="db-shell-sidebar-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              onPointerDown={handleResizerPointerDown}
            />
          )}

          {/* Editor area -- hidden in compact layout when the sidebar is showing. */}
          {(!effectiveCompact || mobileShowEditor) && (
            <main
              aria-label="Document editor"
              className={
                updateAvailable && onApplyUpdate && updateStatusBarVisible
                  ? 'db-shell-editor-area db-shell-editor-area--has-update'
                  : 'db-shell-editor-area'
              }
              style={{
                flex: 1,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                position: 'relative',
              }}
            >
              {selectedFile && mediaProvider ? (
                <>
                  <Suspense
                    fallback={
                      <div className="db-shell-empty" role="status">
                        Loading your document&hellip;
                      </div>
                    }
                  >
                    <EditorShell
                      key={`${selectedFile}-${editorKey}`}
                      initialMarkdown={editorContent}
                      initialView={initialView}
                      defaultViewportPreset={defaultPreviewViewportPreset}
                      articleId={selectedFile}
                      fileName={selectedFile}
                      onChange={handleEditorChange}
                      onLinkClick={handleEditorLinkClick}
                      colorScheme={resolvedTheme}
                      writeCanvasSettings={writeCanvasSettings}
                      height="100%"
                      placeholder={editorPlaceholder}
                      outlineWidth={280}
                      mediaProvider={mediaProvider}
                      documentLinkProvider={documentLinkProvider}
                      workspaceContainer={versionsContainer ?? undefined}
                      allowVersioning={effectiveVersioning}
                      viewPreferences={viewPreferences}
                      onViewPreferencesChange={handleViewPreferencesChange}
                      versionBasename={versionBasename ?? stripExtension(basenameOf(selectedFile))}
                      versioningPrunePolicy={versioningPrunePolicy}
                      versioningAutoSaveIdleMs={versioningAutoSaveIdleMs}
                      onSaveVersion={onSaveVersion}
                      statusBarSlotRight={statusBarSlotRight}
                      toolbarSlotLeft={
                        effectiveCompact ? (
                          <button
                            className="db-mobile-back"
                            onClick={() => setMobileShowEditor(false)}
                            aria-label="Show file list"
                          >
                            <span className="db-mobile-files-icon">
                              <FolderGlyph />
                            </span>
                          </button>
                        ) : undefined
                      }
                      toolbarSlotRight={
                        <>
                          {/* Restore split view -- only relevant when compact
                          layout was manually triggered on a wide viewport.
                          On real mobile, side-by-side doesn't fit so the
                          button is suppressed. */}
                          {compactLayout && !isMobile && (
                            <button
                              className="db-restore-split"
                              onClick={() => setCompactLayout(false)}
                              aria-label="Restore split view"
                              title="Restore split view"
                            >
                              <SplitViewIcon />
                            </button>
                          )}
                          {git.repo && (
                            <Suspense fallback={null}>
                              <GitToolbarControl selectedFile={selectedFile} />
                            </Suspense>
                          )}
                          <ExportToolbarControls
                            selectedFile={selectedFile}
                            mediaContainer={mediaContainerRef.current}
                            destinationAdapter={exportDestinationAdapter}
                            colorScheme={resolvedTheme}
                            videoExportPalette={DOCBLOCKS_VIDEO_EXPORT_PALETTE}
                            ffmpegWasm={ffmpegWasm}
                            initialSharedMode={initialSharedMode}
                          />
                        </>
                      }
                    />
                  </Suspense>
                  {showWelcomeGateway && !isMobile && (
                    <div className="db-welcome-gateway" role="note" aria-label="Welcome tip">
                      <span className="db-welcome-gateway-text">
                        You&rsquo;re watching this welcome doc in <strong>Slideshow</strong>{' '}
                        view&mdash; it&rsquo;s a regular markdown file, and so is everything
                        you&rsquo;ll write.
                      </span>
                      <button className="db-welcome-gateway-cta" onClick={handleStartWriting}>
                        Start writing
                      </button>
                      <button
                        className="db-welcome-gateway-dismiss"
                        onClick={closeWelcomeGateway}
                        aria-label="Dismiss welcome tip"
                        title="Dismiss"
                      >
                        &times;
                      </button>
                    </div>
                  )}
                </>
              ) : selectedFolder ? (
                <div className="db-folder-view">
                  {effectiveCompact && (
                    <button className="db-mobile-back" onClick={() => setMobileShowEditor(false)}>
                      <span className="db-mobile-files-icon">
                        <FolderGlyph />
                      </span>
                      Back to files
                    </button>
                  )}
                  <div className="db-folder-view-header">
                    <span className="db-folder-view-icon">
                      <FolderGlyph />
                    </span>
                    <span className="db-folder-view-path">{selectedFolder}</span>
                  </div>
                  {folderEntries.length === 0 ? (
                    <p className="db-folder-view-empty">This folder is empty.</p>
                  ) : (
                    <ul className="db-folder-view-list">
                      {folderEntries.map((entry) => (
                        <li
                          key={entry.path}
                          className="db-folder-view-item"
                          onClick={() => handleSelect(entry.path, entry.kind)}
                        >
                          <span className="db-folder-view-item-icon">
                            {entry.kind === 'directory' ? <FolderGlyph /> : <FileGlyph />}
                          </span>
                          {entry.name}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <div className="db-shell-empty db-shell-empty--workspace">
                  {effectiveCompact && (
                    <button className="db-mobile-back" onClick={() => setMobileShowEditor(false)}>
                      <span className="db-mobile-files-icon">
                        <FolderGlyph />
                      </span>
                      Back to files
                    </button>
                  )}
                  <div className="db-workspace-empty-content">
                    <span className="db-workspace-empty-icon" aria-hidden="true">
                      <FileGlyph />
                    </span>
                    <h1>{activeWorkspaceDescriptor?.name ?? 'Workspace'}</h1>
                    <p>Choose a Markdown document from the sidebar, or create a new one.</p>
                    <div className="db-workspace-empty-actions">
                      <button type="button" onClick={() => void handleNewFile()}>
                        New document
                      </button>
                      <button
                        type="button"
                        className="db-workspace-empty-secondary"
                        onClick={() => void handleNewFolder()}
                      >
                        New folder
                      </button>
                      {(isElectronHost() ||
                        typeof (globalThis as { showDirectoryPicker?: unknown })
                          .showDirectoryPicker === 'function') && (
                        <button
                          type="button"
                          className="db-workspace-empty-secondary"
                          onClick={() => void handleOpenFolder()}
                        >
                          Open a folder
                        </button>
                      )}
                    </div>
                    <p className="db-workspace-empty-hint">
                      Browser workspaces stay on this device. Use the sidebar backup action to keep
                      a portable copy.
                    </p>
                  </div>
                </div>
              )}
              <UpdateAvailableNotice
                available={updateAvailable}
                onApplyUpdate={onApplyUpdate}
                blocked={documentSnapshot.conflict !== null || storageFull}
                statusBarVisible={updateStatusBarVisible}
              />
            </main>
          )}
        </div>
      </GitContext.Provider>
    </div>
  );
}
