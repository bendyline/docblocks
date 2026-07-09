/**
 * DocBlocksShell — top-level layout component.
 *
 * Composes the left sidebar (WorkspacePicker + FileExplorer) with
 * the center editor area (squisq EditorShell).
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { EditorShell } from '@bendyline/squisq-editor-react';
import type {
  EditorColorScheme,
  EditorView,
  ViewPreferences,
  DocumentLinkProvider,
  DocumentLinkCandidate,
} from '@bendyline/squisq-editor-react';
import '@bendyline/squisq-editor-react/styles';
import { MediaContext } from '@bendyline/squisq-react';
import type { MediaProvider } from '@bendyline/squisq/schemas';
import {
  DocumentVersionManager,
  type PrunePolicy,
  type SaveVersionResult,
} from '@bendyline/squisq/versions';
import type { FileSystemProvider, FileSystemEntry } from '@bendyline/docblocks/filesystem';
import {
  IndexedDBFileSystemProvider,
  MemoryFileSystemProvider,
  ElectronFileSystemProvider,
  FileSystemContentContainer,
  createFileMediaProvider,
  openNativeFolder,
  restoreNativeFolder,
  removeDirectoryHandle,
} from '@bendyline/docblocks/filesystem';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { isElectronHost, getDocBlocksHost } from '@bendyline/docblocks/host';
import type { OpenRequest } from '@bendyline/docblocks/host';
import type { WorkspaceDescriptor } from '@bendyline/docblocks/workspace';
import {
  ensureDefaultWorkspace,
  getWorkspace,
  listWorkspaces,
  removeWorkspace,
  saveWorkspace,
  touchWorkspace,
  registerTransientWorkspace,
  getTransientWorkspace,
} from '@bendyline/docblocks/workspace';
import { AppMenu, type ThemePreference } from '../AppMenu/AppMenu.js';
import { FileExplorer } from '../FileExplorer/FileExplorer.js';
import { WorkspacePicker } from '../WorkspacePicker/WorkspacePicker.js';
import { WorkspaceSettingsButton } from '../WorkspacePicker/WorkspaceSettingsButton.js';
import {
  WorkspaceSettingsDialog,
  type WorkspaceVersioningOverride,
} from '../WorkspacePicker/WorkspaceSettingsDialog.js';
import { useAutoSave } from '../hooks/useAutoSave.js';
import { ExportToolbarControls } from '../Export/ExportToolbarControls.js';
import {
  loadVersioningPreference,
  resolveVersioningEnabled,
  saveVersioningPreference,
  type VersioningPreference,
} from '../preferences/versioning.js';

export interface DocBlocksShellProps {
  /** Optional theme override. Omit or pass 'auto' to follow OS preference. */
  theme?: EditorColorScheme | 'auto';
  /** Optional logo image URL for the app menu. */
  logoUrl?: string;
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
  const slashIdx = raw.indexOf('/');
  if (slashIdx === -1) {
    return { workspaceId: decodeURIComponent(raw), filePath: null };
  }
  return {
    workspaceId: decodeURIComponent(raw.slice(0, slashIdx)),
    filePath: '/' + decodeURIComponent(raw.slice(slashIdx + 1)),
  };
}

const LAST_STATE_KEY = 'docblocks:lastState';

interface LastState {
  workspaceId: string;
  filePath: string;
  view: EditorView;
}

function saveLastState(state: LastState): void {
  try {
    localStorage.setItem(LAST_STATE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota errors
  }
}

function loadLastState(): LastState | null {
  try {
    const raw = localStorage.getItem(LAST_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** One-time first-run callout shown over the welcome doc's Play view.
 *  Once the user starts writing, switches views themselves, or dismisses
 *  it, it never comes back — on any workspace. */
const WELCOME_GATEWAY_KEY = 'docblocks:welcomeGatewayDismissed';

function isWelcomeGatewayDismissed(): boolean {
  try {
    return localStorage.getItem(WELCOME_GATEWAY_KEY) === '1';
  } catch {
    return false;
  }
}

function markWelcomeGatewayDismissed(): void {
  try {
    localStorage.setItem(WELCOME_GATEWAY_KEY, '1');
  } catch {
    // ignore quota errors
  }
}

const THEME_PREF_KEY = 'docblocks:themePreference';

function loadThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_PREF_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw;
  } catch {
    // ignore
  }
  return 'auto';
}

function saveThemePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(THEME_PREF_KEY, pref);
  } catch {
    // ignore quota errors
  }
}

const SIDEBAR_WIDTH_KEY = 'docblocks:sidebarWidth';
const SIDEBAR_WIDTH_DEFAULT = 260;
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 600;
/** Drag below this many pixels and the sidebar collapses entirely —
 *  the editor takes the full width and a back-arrow appears in the
 *  toolbar so the user can pop the sidebar back open. Same UX as
 *  the existing mobile narrow-viewport flow. */
const SIDEBAR_COLLAPSE_THRESHOLD = 120;

function loadSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw === null) return SIDEBAR_WIDTH_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return SIDEBAR_WIDTH_DEFAULT;
    return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, n));
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

function saveSidebarWidth(px: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(px)));
  } catch {
    // ignore quota errors
  }
}

const VIEW_PREFS_KEY = 'docblocks:viewPreferences';

const DEFAULT_VIEW_PREFS: ViewPreferences = {
  outline: false,
  inlinePreview: true,
  showStatusBar: true,
};

function loadViewPreferences(): ViewPreferences {
  try {
    const raw = localStorage.getItem(VIEW_PREFS_KEY);
    if (!raw) return DEFAULT_VIEW_PREFS;
    const parsed = JSON.parse(raw) as Partial<ViewPreferences>;
    return {
      outline: typeof parsed.outline === 'boolean' ? parsed.outline : DEFAULT_VIEW_PREFS.outline,
      inlinePreview:
        typeof parsed.inlinePreview === 'boolean'
          ? parsed.inlinePreview
          : DEFAULT_VIEW_PREFS.inlinePreview,
      showStatusBar:
        typeof parsed.showStatusBar === 'boolean'
          ? parsed.showStatusBar
          : DEFAULT_VIEW_PREFS.showStatusBar,
    };
  } catch {
    return DEFAULT_VIEW_PREFS;
  }
}

function saveViewPreferences(prefs: ViewPreferences): void {
  try {
    localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore quota errors
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
  return '/' + p.replace(/^\/+/, '');
}

function sameProviderPath(a: string, b: string): boolean {
  return normaliseProviderPath(a) === normaliseProviderPath(b);
}

/** Portable relative link from one workspace file to another. Walks up
 *  from the source's directory and back down to the target so the link
 *  survives folder reshuffles (`../sibling.md`, `subfolder/child.md`,
 *  `resume.md` for siblings at the workspace root). */
function relativeMarkdownLink(fromFile: string, toFile: string): string {
  const fromParts = fromFile.replace(/^\/+/, '').split('/').filter(Boolean);
  const toParts = toFile.replace(/^\/+/, '').split('/').filter(Boolean);
  const fromDir = fromParts.slice(0, -1);
  const toDir = toParts.slice(0, -1);
  const toBase = toParts[toParts.length - 1] ?? '';
  let common = 0;
  while (common < fromDir.length && common < toDir.length && fromDir[common] === toDir[common]) {
    common++;
  }
  const ups = fromDir.length - common;
  const downs = [...toDir.slice(common), toBase];
  const parts = [...Array(ups).fill('..'), ...downs];
  return parts.length === 0 ? toBase : parts.join('/');
}

/** Recursively collect all `.md` files reachable from `root`. Skips
 *  Word-style `*_files/` asset companions, dotfiles, and `node_modules`
 *  so the candidate list stays workspace-meaningful. */
async function collectMarkdownFiles(
  fs: FileSystemProvider,
  root: string,
): Promise<FileSystemEntry[]> {
  const out: FileSystemEntry[] = [];
  const visited = new Set<string>();

  async function walk(dir: string): Promise<void> {
    if (visited.has(dir)) return;
    visited.add(dir);
    let entries: FileSystemEntry[];
    try {
      entries = await fs.readDirectory(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.kind === 'directory') {
        const lower = entry.name.toLowerCase();
        if (lower.startsWith('.')) continue;
        if (lower === 'node_modules') continue;
        if (lower.endsWith('_files')) continue;
        await walk(entry.path);
      } else if (entry.kind === 'file') {
        if (entry.name.toLowerCase().endsWith('.md')) out.push(entry);
      }
    }
  }

  await walk(root);
  return out;
}

async function createElectronProviderFromWorkspace(
  ws: WorkspaceDescriptor,
): Promise<ElectronFileSystemProvider | null> {
  if (!ws.rootPath) return null;
  try {
    await getDocBlocksHost().workspaces.register({
      id: ws.id,
      name: ws.name,
      rootPath: ws.rootPath,
    });
  } catch {
    return null;
  }
  return new ElectronFileSystemProvider(ws.id, ws.name, ws.rootPath);
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
  theme: _themeProp = 'auto',
  logoUrl,
  allowVersioning = true,
  versionBasename,
  versioningPrunePolicy,
  versioningAutoSaveIdleMs,
  onSaveVersion,
  versioningRef,
}: DocBlocksShellProps) {
  const osTheme = useOsTheme();
  const [themePreference, setThemePreference] = useState<ThemePreference>(loadThemePreference);
  // "System default" (auto) always follows the OS — the host's theme prop
  // is kept only for API back-compat and does not override OS detection.
  const resolvedTheme: 'light' | 'dark' =
    themePreference === 'light' || themePreference === 'dark' ? themePreference : osTheme;

  const handleThemeChange = useCallback((pref: ThemePreference) => {
    setThemePreference(pref);
    saveThemePreference(pref);
  }, []);

  const [viewPreferences, setViewPreferences] = useState<ViewPreferences>(loadViewPreferences);
  const handleViewPreferencesChange = useCallback((prefs: ViewPreferences) => {
    setViewPreferences(prefs);
    saveViewPreferences(prefs);
  }, []);
  const isMobile = useIsMobile();
  const [mobileShowEditor, setMobileShowEditor] = useState(false);
  // Sidebar width — persisted across sessions, dragged via the resizer
  // between sidebar and editor area. We track the "live" width during a
  // drag in a ref so each mousemove doesn't trigger a state update; only
  // setState on commit so React doesn't churn through every pixel.
  const [sidebarWidth, setSidebarWidth] = useState<number>(loadSidebarWidth);
  // When the user drags the resizer below SIDEBAR_COLLAPSE_THRESHOLD,
  // we switch the layout into single-pane "compact" mode — same UX as
  // the mobile narrow-viewport flow, where only the sidebar OR the
  // editor is visible at a time and a back-arrow in the toolbar pops
  // between them. A "Restore split view" button on the editor toolbar
  // exits compact mode; on real mobile that button is suppressed
  // because there's not enough viewport for side-by-side. Not
  // persisted across reloads. */
  const [compactLayout, setCompactLayout] = useState(false);
  const effectiveCompact = isMobile || compactLayout;
  const showBrowserStorageWarning = !isElectronHost();
  const [browserStoragePersistent, setBrowserStoragePersistent] = useState(false);
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
          // Below threshold — preview the collapse by snapping to the
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
          // Released below threshold — switch to compact (single-pane)
          // layout focused on the editor. Keep the persisted
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
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [activeWorkspaceDescriptor, setActiveWorkspaceDescriptor] =
    useState<WorkspaceDescriptor | null>(null);
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
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [folderEntries, setFolderEntries] = useState<FileSystemEntry[]>([]);
  const [editorContent, setEditorContent] = useState('');
  const [editorKey, setEditorKey] = useState(0);
  const [explorerKey, setExplorerKey] = useState(0);
  const [initialView, setInitialView] = useState<EditorView>('wysiwyg');
  // First-run gateway over the welcome doc's Play view — see WELCOME_GATEWAY_KEY.
  const [showWelcomeGateway, setShowWelcomeGateway] = useState(false);
  /** Suppress popstate handling during programmatic navigation. */
  const skipPopState = useRef(false);
  const lastLocalSaveRef = useRef<{
    filePath: string;
    content: string;
    savedAt: number;
  } | null>(null);

  /**
   * Per-file media container: for `notes.md`, images live in
   * `notes_files/` next to the markdown. Created lazily on first write,
   * picked up automatically if it already exists. Set up by the effect
   * below whenever the selected file (or backing provider) changes.
   */
  const mediaContainerRef = useRef<ContentContainer | null>(null);
  const [mediaProvider, setMediaProvider] = useState<MediaProvider | null>(null);
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

  /** Cache of .md files in the active workspace, used to power the
   *  squisq link-dialog's document picker. Lazily populated on first
   *  provider call; cleared whenever the backing filesystem changes so
   *  workspace switches don't surface stale neighbours. A pending Promise
   *  during in-flight walks lets concurrent calls share the same scan. */
  const mdFileCacheRef = useRef<Promise<FileSystemEntry[]> | null>(null);

  /** Push a new history entry with the given hash. */
  const pushHash = useCallback((wsId: string, filePath?: string | null) => {
    const hash = buildHash(wsId, filePath);
    if (window.location.hash !== hash) {
      skipPopState.current = true;
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
    ): Promise<FileSystemProvider | null> => {
      // Transient (session-only) workspaces — a loose file or `.dbk` opened
      // from the OS — carry a pre-built in-memory provider in the registry.
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
          const restored = await restoreNativeFolder(ws.id);
          if (!restored) return null;
          fsProvider = restored;
        } else {
          fsProvider = new IndexedDBFileSystemProvider(ws.id, ws.name);
        }
      }
      if (!ws || !fsProvider) return null;
      await touchWorkspace(ws.id);
      setProvider(fsProvider);
      setActiveWorkspaceId(ws.id);

      if (filePath) {
        const content = await fsProvider.readFile(filePath);
        if (content !== null) {
          setSelectedFile(filePath);
          setSelectedFolder(null);
          setFolderEntries([]);
          setEditorContent(content);
          const effectiveView = view ?? 'wysiwyg';
          setInitialView(effectiveView);
          setEditorKey((k) => k + 1);
          // Transient workspaces are session-only; don't persist them as the
          // "last opened" state (the id won't exist after a reload).
          if (!transient) {
            saveLastState({ workspaceId: wsId, filePath, view: effectiveView });
          }
        } else {
          setSelectedFile(null);
          setSelectedFolder(null);
          setFolderEntries([]);
          setEditorContent('');
          setEditorKey((k) => k + 1);
        }
      } else {
        setSelectedFile(null);
        setSelectedFolder(null);
        setFolderEntries([]);
        setEditorContent('');
        setEditorKey((k) => k + 1);
      }

      if (push) {
        pushHash(ws.id, filePath);
      }
      return fsProvider;
    },
    [pushHash],
  );

  const seedWelcomeFile = useCallback(
    async (fs: FileSystemProvider) => {
      const entries = await fs.readDirectory('/');

      // If the only file is the welcome doc, auto-select it.
      // Match either casing so workspaces seeded before the rename
      // (aboutDocblocks.md) keep working alongside new ones (aboutDocBlocks.md).
      if (
        entries.length === 1 &&
        entries[0].kind === 'file' &&
        entries[0].path.replace(/^\//, '').toLowerCase() === 'aboutdocblocks.md'
      ) {
        const aboutPath = entries[0].path;
        const content = await fs.readFile(aboutPath);
        if (content !== null) {
          setSelectedFile(aboutPath);
          setEditorContent(content);
          setInitialView('preview');
          setEditorKey((k) => k + 1);
          setExplorerKey((k) => k + 1);
          pushHash(fs.id, aboutPath);
          saveLastState({ workspaceId: fs.id, filePath: aboutPath, view: 'preview' });
          if (!isWelcomeGatewayDismissed()) setShowWelcomeGateway(true);
        }
        return;
      }

      if (entries.length > 0) return;

      const welcomePath = '/aboutDocBlocks.md';
      const welcomeContent = [
        '# Welcome to DocBlocks',
        '',
        'your docs as exquisite blocks',
        '',
        'DocBlocks is a free browser-based markdown document editor that lets you create, organize, and manage your documents right in the browser. What you write here can become a Word or PDF doc, a slide deck, an e-book, or a video.',
        '',
        'Simple to write. Beautiful wherever it goes.',
        '',
        '## Features',
        '',
        '- **Rich Markdown Editing** — Write in a visual editor or switch to raw markdown anytime. Use section annotations to change the visualization for blocks of content.',
        '- **Workspaces** — Organize your documents into separate workspaces in the browser or on your device.',
        '- **Useful Everywhere** — Your content is usable across multiple formats — Microsoft Word .docx, PowerPoint, PDF, HTML, EPUB e-books, and Markdown.',
        '- **Playback & Video** — Preview your documents as rich visual presentations and export them as MP4 video',
        '- **No BS** — Free, no ads, no accounts, no tracking - everything runs locally in your browser',
        '',
        '## Getting Started',
        '',
        '1. Create a new file using the **New File** button in the sidebar',
        '2. Start writing in markdown — the editor supports headings, lists, links, images, and more',
        '3. Your work is saved automatically',
        '',
        'Built with [Squiggly Square](https://github.com/bendyline/squisq) by [Bendyline](https://bendyline.com).',
      ].join('\n');

      await fs.writeFile(welcomePath, welcomeContent);
      setSelectedFile(welcomePath);
      setEditorContent(welcomeContent);
      setInitialView('preview');
      setEditorKey((k) => k + 1);
      setExplorerKey((k) => k + 1);
      pushHash(fs.id, welcomePath);
      saveLastState({ workspaceId: fs.id, filePath: welcomePath, view: 'preview' });
      if (!isWelcomeGatewayDismissed()) setShowWelcomeGateway(true);
    },
    [pushHash],
  );

  /** Hide the welcome gateway and never show it again. Safe to call from
   *  paths where it may not be showing — only persists when it was. */
  const closeWelcomeGateway = useCallback(() => {
    setShowWelcomeGateway((showing) => {
      if (showing) markWelcomeGatewayDismissed();
      return false;
    });
  }, []);

  /** Gateway CTA — flip the welcome doc from Play into the editor. */
  const handleStartWriting = useCallback(() => {
    closeWelcomeGateway();
    setInitialView('wysiwyg');
    setEditorKey((k) => k + 1);
    if (activeWorkspaceId && selectedFile) {
      saveLastState({ workspaceId: activeWorkspaceId, filePath: selectedFile, view: 'wysiwyg' });
    }
  }, [closeWelcomeGateway, activeWorkspaceId, selectedFile]);

  // Initialise workspace on mount — restore from hash or last-used
  useEffect(() => {
    (async () => {
      // Try restoring from URL hash first
      const hashState = parseHash();
      if (hashState) {
        const restoredProvider = await openFromIds(
          hashState.workspaceId,
          hashState.filePath,
          false,
        );
        if (restoredProvider) {
          // If the hash had no file, check whether we should auto-select the welcome doc
          if (!hashState.filePath) {
            await seedWelcomeFile(restoredProvider);
          }
          return;
        }
      }

      // Try restoring last viewed document from localStorage
      const lastState = loadLastState();
      if (lastState) {
        const restoredProvider = await openFromIds(
          lastState.workspaceId,
          lastState.filePath,
          true,
          lastState.view,
        );
        if (restoredProvider) return;
      }

      let fsProvider: FileSystemProvider | null = null;

      const electron = isElectronHost();
      const workspaces = await listWorkspaces();
      // On desktop, hide web-only workspaces (indexeddb/native) — only
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
          await touchWorkspace(ws.id);
          fsProvider = p;
          setProvider(p);
          setActiveWorkspaceId(ws.id);
          break;
        } else if (ws.type === 'native') {
          const restored = await restoreNativeFolder(ws.id);
          if (restored) {
            await touchWorkspace(ws.id);
            fsProvider = restored;
            setProvider(restored);
            setActiveWorkspaceId(ws.id);
            break;
          }
        } else {
          const p = new IndexedDBFileSystemProvider(ws.id, ws.name);
          await touchWorkspace(ws.id);
          fsProvider = p;
          setProvider(p);
          setActiveWorkspaceId(ws.id);
          break;
        }
      }

      if (!fsProvider) {
        if (electron) {
          // Desktop: ask the host for the default folder workspace
          // (creates ~/Documents/DocBlocks on first launch).
          const info = await getDocBlocksHost().workspaces.getDefault();
          const descriptor: WorkspaceDescriptor = {
            id: info.id,
            name: info.name,
            type: 'electron-native',
            rootPath: info.rootPath,
            lastOpened: new Date().toISOString(),
          };
          await saveWorkspace(descriptor);
          const p = new ElectronFileSystemProvider(info.id, info.name, info.rootPath);
          fsProvider = p;
          setProvider(p);
          setActiveWorkspaceId(info.id);
        } else {
          // Web: create the IndexedDB default workspace
          const defaultWs = await ensureDefaultWorkspace();
          const p = new IndexedDBFileSystemProvider(defaultWs.id, defaultWs.name);
          fsProvider = p;
          setProvider(p);
          setActiveWorkspaceId(defaultWs.id);
        }
      }

      // Set initial hash
      pushHash(fsProvider.id, null);

      // Seed welcome file if workspace is empty
      await seedWelcomeFile(fsProvider);
    })();
  }, [openFromIds, pushHash, seedWelcomeFile]);

  // Handle browser back/forward
  useEffect(() => {
    const onPopState = () => {
      if (skipPopState.current) {
        skipPopState.current = false;
        return;
      }
      const hashState = parseHash();
      if (hashState) {
        openFromIds(hashState.workspaceId, hashState.filePath, false);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [openFromIds]);

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

  // Track view mode changes (Editor/Raw/Play tabs) and persist to localStorage
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest?.('[data-view]');
      if (target) {
        const view = target.getAttribute('data-view') as EditorView;
        if (view) {
          // The user found the view tabs on their own — the gateway's job is done.
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

  const handleAutoSaved = useCallback((filePath: string, savedContent: string) => {
    lastLocalSaveRef.current = {
      filePath: normaliseProviderPath(filePath),
      content: savedContent,
      savedAt: Date.now(),
    };
  }, []);

  // Auto-save current file. The returned `flush` is called from the
  // Ctrl/Cmd+S handler below so the user gets immediate confirmation.
  const { flush: flushAutoSave } = useAutoSave(
    provider,
    selectedFile,
    editorContent,
    500,
    handleAutoSaved,
  );

  // Comfort-blanket Ctrl/Cmd+S: flushes any pending autosave and pops a
  // small "auto-save confirmed" toast. Files are already saved on every
  // keystroke (debounced) — this is purely UX reassurance for users who
  // muscle-memory hit Save.
  const [saveToastVisible, setSaveToastVisible] = useState(false);
  const saveToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const sKey = e.key === 's' || e.key === 'S';
      const accel = e.ctrlKey || e.metaKey;
      if (!sKey || !accel || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      void flushAutoSave().catch(() => undefined);
      setSaveToastVisible(true);
      if (saveToastTimerRef.current) clearTimeout(saveToastTimerRef.current);
      saveToastTimerRef.current = setTimeout(() => setSaveToastVisible(false), 1800);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [flushAutoSave]);
  useEffect(() => {
    return () => {
      if (saveToastTimerRef.current) clearTimeout(saveToastTimerRef.current);
    };
  }, []);

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
  }, [provider, selectedFile]);

  // Invalidate the document-link candidate cache when the backing
  // workspace changes — otherwise the link dialog would surface
  // neighbours from a previously-open workspace.
  useEffect(() => {
    mdFileCacheRef.current = null;
  }, [provider]);

  /** Powers the squisq link dialog's "Browse documents" picker. Returns
   *  workspace `.md` neighbours filtered by `query`, with paths expressed
   *  relative to the currently-open document so the link survives folder
   *  moves. The first call seeds an in-memory cache; subsequent calls
   *  filter against it. */
  const documentLinkProvider = useCallback<DocumentLinkProvider>(
    async (query: string): Promise<DocumentLinkCandidate[]> => {
      if (!provider || !selectedFile) return [];
      if (!mdFileCacheRef.current) {
        mdFileCacheRef.current = collectMarkdownFiles(provider, '').catch(() => []);
      }
      const entries = await mdFileCacheRef.current;
      const q = query.trim().toLowerCase();
      const candidates: DocumentLinkCandidate[] = [];
      for (const entry of entries) {
        if (entry.kind !== 'file') continue;
        if (sameProviderPath(entry.path, selectedFile)) continue;
        const label = entry.name.replace(/\.md$/i, '');
        const path = relativeMarkdownLink(selectedFile, entry.path);
        if (q && !label.toLowerCase().includes(q) && !path.toLowerCase().includes(q)) continue;
        const dir = dirnameOf(entry.path);
        candidates.push(dir ? { path, label, description: dir } : { path, label });
      }
      // Stable alphabetical order keeps the picker predictable across
      // re-opens; the dialog can re-sort or rank on its own if needed.
      candidates.sort((a, b) => a.label.localeCompare(b.label));
      return candidates;
    },
    [provider, selectedFile],
  );

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
    if (!isElectronHost()) return;
    if (!provider || !(provider instanceof ElectronFileSystemProvider)) return;
    const unwatch = provider.watch((changedPath) => {
      setExplorerKey((k) => k + 1);
      if (!selectedFile || !sameProviderPath(changedPath, selectedFile)) return;

      // If the open file's contents changed on disk, reload it (best-effort).
      (async () => {
        const content = await provider.readFile(selectedFile);
        if (content === null || content === editorContent) return;

        const localSave = lastLocalSaveRef.current;
        if (
          localSave &&
          sameProviderPath(localSave.filePath, selectedFile) &&
          localSave.content === content &&
          Date.now() - localSave.savedAt < 5000
        ) {
          return;
        }

        setEditorContent(content);
        setEditorKey((k) => k + 1);
      })();
    });
    return unwatch;
  }, [provider, selectedFile, editorContent]);

  const handleWorkspaceSelect = useCallback(
    async (ws: WorkspaceDescriptor) => {
      await touchWorkspace(ws.id);
      let nextProvider: FileSystemProvider | null = null;
      const transient = getTransientWorkspace(ws.id);
      if (transient) {
        nextProvider = transient.provider;
      } else if (ws.type === 'electron-native') {
        nextProvider = await createElectronProviderFromWorkspace(ws);
        if (!nextProvider) return;
      } else if (ws.type === 'native') {
        const restored = await restoreNativeFolder(ws.id);
        if (!restored) {
          // Permission denied or handle lost — fall through without changing provider
          return;
        }
        nextProvider = restored;
      } else {
        nextProvider = new IndexedDBFileSystemProvider(ws.id, ws.name);
      }
      setProvider(nextProvider);
      setActiveWorkspaceId(ws.id);
      setSelectedFile(null);
      setSelectedFolder(null);
      setFolderEntries([]);
      setEditorContent('');
      setEditorKey((k) => k + 1);
      pushHash(ws.id, null);
    },
    [pushHash],
  );

  const handleOpenFolder = useCallback(async () => {
    try {
      if (isElectronHost()) {
        const info = await getDocBlocksHost().workspaces.pickFolder();
        if (!info) return; // user cancelled
        const descriptor: WorkspaceDescriptor = {
          id: info.id,
          name: info.name,
          type: 'electron-native',
          rootPath: info.rootPath,
          lastOpened: new Date().toISOString(),
        };
        await saveWorkspace(descriptor);
        const provider = new ElectronFileSystemProvider(info.id, info.name, info.rootPath);
        setProvider(provider);
        setActiveWorkspaceId(descriptor.id);
        setSelectedFile(null);
        setSelectedFolder(null);
        setFolderEntries([]);
        setEditorContent('');
        setEditorKey((k) => k + 1);
        pushHash(descriptor.id, null);
        return;
      }

      const nativeProvider = await openNativeFolder();
      const descriptor: WorkspaceDescriptor = {
        id: nativeProvider.id,
        name: nativeProvider.label,
        type: 'native',
        lastOpened: new Date().toISOString(),
      };
      await saveWorkspace(descriptor);
      setProvider(nativeProvider);
      setActiveWorkspaceId(descriptor.id);
      setSelectedFile(null);
      setSelectedFolder(null);
      setFolderEntries([]);
      setEditorContent('');
      setEditorKey((k) => k + 1);
      pushHash(descriptor.id, null);
    } catch {
      // User cancelled or API not supported
    }
  }, [pushHash]);

  const handleNewFile = useCallback(async () => {
    if (!provider) return;
    const name = prompt('New document name:', 'Untitled.md');
    if (!name) return;
    const filename = /\.[a-zA-Z0-9]+$/.test(name) ? name : `${name}.md`;
    await provider.writeFile(filename, '# ' + filename.replace(/\.[^.]+$/, '') + '\n');
    setSelectedFile('/' + filename);
    setEditorContent('# ' + filename.replace(/\.[^.]+$/, '') + '\n');
    setInitialView('wysiwyg');
    setEditorKey((k) => k + 1);
    setExplorerKey((k) => k + 1);
    closeWelcomeGateway();
    if (activeWorkspaceId) {
      pushHash(activeWorkspaceId, '/' + filename);
    }
  }, [provider, activeWorkspaceId, pushHash, closeWelcomeGateway]);

  const handleRevealWorkspace = useCallback(async () => {
    if (!isElectronHost() || !activeWorkspaceId) return;
    const ws = await getWorkspace(activeWorkspaceId);
    if (ws?.type === 'electron-native' && ws.rootPath) {
      await getDocBlocksHost().shell.revealInFolder(ws.rootPath);
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
        case 'help:viewOnGitHub':
          host.shell.openExternal('https://github.com/bendyline/docblocks');
          break;
        case 'help:checkForUpdates':
          host.updater.checkForUpdates().catch(() => {
            // errors surface via updater.onStatus
          });
          break;
        case 'help:about':
          (async () => {
            const version = await host.updater.getVersion();
            alert(`DocBlocks ${version}`);
          })();
          break;
        default:
          break;
      }
    });
  }, [handleNewFile, handleOpenFolder, handleRevealWorkspace]);

  // OS open-file / deep-link handling lives after the container helpers it
  // depends on — see the `openTransient` + onOpenRequest effect below.

  const handleSelect = useCallback(
    async (path: string, kind: 'file' | 'directory') => {
      if (!provider || !activeWorkspaceId) return;

      if (kind === 'directory') {
        setSelectedFile(null);
        setSelectedFolder(path);
        const entries = await provider.readDirectory(path);
        setFolderEntries(entries);
        setEditorContent('');
        setEditorKey((k) => k + 1);
        pushHash(activeWorkspaceId, null);
      } else {
        const content = await provider.readFile(path);
        setSelectedFile(path);
        setSelectedFolder(null);
        setFolderEntries([]);
        setEditorContent(content ?? '');
        setInitialView('wysiwyg');
        setEditorKey((k) => k + 1);
        closeWelcomeGateway();
        pushHash(activeWorkspaceId, path);
        saveLastState({ workspaceId: activeWorkspaceId, filePath: path, view: 'wysiwyg' });
        if (effectiveCompact) setMobileShowEditor(true);
      }
    },
    [provider, activeWorkspaceId, pushHash, effectiveCompact, closeWelcomeGateway],
  );

  const handleTreeChange = useCallback(async () => {
    if (!provider) return;
    // If the open file was deleted, clear the editor
    if (selectedFile) {
      const exists = await provider.exists(selectedFile);
      if (!exists) {
        setSelectedFile(null);
        setEditorContent('');
        setEditorKey((k) => k + 1);
        if (activeWorkspaceId) pushHash(activeWorkspaceId, null);
      }
    }
    if (selectedFolder) {
      const entries = await provider.readDirectory(selectedFolder);
      setFolderEntries(entries);
    }
  }, [provider, selectedFile, selectedFolder, activeWorkspaceId, pushHash]);

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
      for (const entry of entries) {
        if (entry.path.endsWith('.md')) continue;
        const data = await source.readFile(entry.path);
        if (!data) continue;
        const cleanPath = entry.path.replace(/^\/+/, '');
        await target.writeBinary(`${mediaRoot}/${cleanPath}`, new Uint8Array(data));
      }
    },
    [],
  );

  const handleImportFiles = useCallback(
    async (files: File[]) => {
      if (!provider) return;
      for (const file of files) {
        const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
        const baseName = file.name.replace(/\.[^.]+$/, '');
        const destPath = `${baseName}.md`;

        try {
          let markdown: string;
          if (ext === '.md' || ext === '.txt') {
            markdown = await file.text();
          } else if (ext === '.docx') {
            const { docxToContainer } = await import('@bendyline/squisq-formats/docx');
            const container = await docxToContainer(await file.arrayBuffer());
            markdown = (await container.readDocument()) ?? '';
            await persistImportedMedia(container, provider, destPath);
          } else if (ext === '.pdf') {
            const { pdfToContainer } = await import('@bendyline/squisq-formats/pdf');
            const container = await pdfToContainer(await file.arrayBuffer());
            markdown = (await container.readDocument()) ?? '';
            await persistImportedMedia(container, provider, destPath);
          } else if (ext === '.dbk' || ext === '.zip') {
            const { zipToContainer } = await import('@bendyline/squisq-formats/container');
            const container = await zipToContainer(await file.arrayBuffer());
            markdown = (await container.readDocument()) ?? '';
            await persistImportedMedia(container, provider, destPath);
          } else {
            continue;
          }

          await provider.writeFile(destPath, markdown);
        } catch (err) {
          console.error(`Failed to import ${file.name}:`, err);
        }
      }
      // Refresh file tree so the new markdown files + _files folders show up.
      setExplorerKey((k) => k + 1);
    },
    [provider, persistImportedMedia],
  );

  const handleEditorChange = useCallback((source: string) => {
    setEditorContent(source);
  }, []);

  const handleRenameWorkspace = useCallback(async () => {
    if (!activeWorkspaceId) return;
    const ws = await getWorkspace(activeWorkspaceId);
    if (!ws) return;
    const newName = prompt('Rename workspace:', ws.name);
    if (!newName || newName === ws.name) return;
    await saveWorkspace({ ...ws, name: newName });
    // Bump key to trigger re-render — workspace name is read from the descriptor, not the provider
    setEditorKey((k) => k + 1);
  }, [activeWorkspaceId]);

  /**
   * Walk a FileSystemProvider and copy every file into `container` under
   * `pathPrefix` (no leading slash; empty string for the root). Used by
   * both single- and all-workspace downloads.
   */
  const copyProviderToContainer = useCallback(
    async (
      src: FileSystemProvider,
      container: { writeFile: (path: string, data: ArrayBuffer | Uint8Array) => Promise<void> },
      pathPrefix: string,
    ): Promise<void> => {
      const encoder = new TextEncoder();
      const stack: string[] = ['/'];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        const entries = await src.readDirectory(dir);
        for (const entry of entries) {
          if (entry.kind === 'directory') {
            stack.push(entry.path);
            continue;
          }
          const rel = entry.path.replace(/^\/+/, '');
          const zipPath = pathPrefix ? `${pathPrefix}/${rel}` : rel;
          // Files may be stored as text (writeFile) or binary (writeBinary);
          // try binary first, fall back to text and encode as UTF-8.
          const binary = await src.readBinary(entry.path);
          if (binary) {
            await container.writeFile(zipPath, binary);
            continue;
          }
          const text = await src.readFile(entry.path);
          if (text !== null) {
            await container.writeFile(zipPath, encoder.encode(text));
          }
        }
      }
    },
    [],
  );

  /**
   * Open a loose file or `.dbk` bundle delivered by the OS into a session-only
   * *transient* workspace backed by an in-memory provider. Loose files save
   * straight back to disk; bundles are re-zipped (see the save-back effect).
   */
  const openTransient = useCallback(
    async (req: Extract<OpenRequest, { kind: 'external-file' | 'external-bundle' }>) => {
      const host = getDocBlocksHost();
      const id = `transient-${req.kind}-${req.path}`;
      const mem = new MemoryFileSystemProvider(id, req.name);
      let primaryFile: string;
      let origin: WorkspaceDescriptor['origin'];

      if (req.kind === 'external-file') {
        const content = (await host.external.readText(req.path)) ?? '';
        primaryFile = req.name; // e.g. "notes.md"
        mem.seedText(primaryFile, content);
        origin = { kind: 'loose-file', path: req.path };
      } else {
        const bytes = await host.external.readBinary(req.path);
        if (!bytes) return;
        const { zipToContainer } = await import('@bendyline/squisq-formats/container');
        const container = await zipToContainer(bytes);
        const markdown = (await container.readDocument()) ?? '';
        const base = req.name.replace(/\.[^.]+$/, '');
        primaryFile = `${base}.md`;
        mem.seedText(primaryFile, markdown);
        await persistImportedMedia(container, mem, primaryFile);
        origin = { kind: 'dbk', path: req.path };
      }

      const descriptor: WorkspaceDescriptor = {
        id,
        name: req.name,
        type: 'transient',
        lastOpened: new Date().toISOString(),
        origin,
      };
      registerTransientWorkspace(descriptor, mem);
      await openFromIds(id, `/${primaryFile}`, true);
    },
    [openFromIds, persistImportedMedia],
  );

  // Subscribe to OS open-file / deep-link requests.
  useEffect(() => {
    if (!isElectronHost()) return;
    const host = getDocBlocksHost();
    return host.onOpenRequest(async (req) => {
      if (req.kind === 'workspace-file') {
        await openFromIds(req.workspaceId, req.path, true);
      } else {
        await openTransient(req);
      }
    });
  }, [openFromIds, openTransient]);

  // Debounced save-back for transient workspaces. Loose files write straight to
  // disk; `.dbk` bundles are re-zipped from the in-memory provider. Both go
  // through the session-allowlisted `external` IPC. No-op for normal workspaces.
  useEffect(() => {
    if (!isElectronHost() || !activeWorkspaceId || !provider || !selectedFile) return;
    const t = getTransientWorkspace(activeWorkspaceId);
    const origin = t?.descriptor.origin;
    if (!t || !origin) return;

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const host = getDocBlocksHost();
          if (origin.kind === 'loose-file') {
            await host.external.writeText(origin.path, editorContent);
          } else {
            if (selectedFile.endsWith('.md')) {
              await t.provider.writeFile(selectedFile, editorContent);
            }
            const [{ MemoryContentContainer }, { containerToZip }] = await Promise.all([
              import('@bendyline/squisq/storage'),
              import('@bendyline/squisq-formats/container'),
            ]);
            const container = new MemoryContentContainer();
            await copyProviderToContainer(t.provider, container, '');
            const blob = await containerToZip(container);
            await host.external.writeBinary(origin.path, await blob.arrayBuffer());
          }
        } catch (err) {
          console.error('Failed to save transient workspace back to origin:', err);
        }
      })();
    }, 800);
    return () => clearTimeout(timer);
  }, [editorContent, activeWorkspaceId, provider, selectedFile, copyProviderToContainer]);

  const handleDownloadWorkspace = useCallback(async () => {
    if (!provider) return;
    try {
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
      alert('Failed to download workspace. See console for details.');
    }
  }, [provider, copyProviderToContainer]);

  /**
   * Bundle every workspace the host can open without further prompting
   * into a single zip, with each workspace nested under its own folder.
   * Native (browser-picked) workspaces whose handle hasn't been re-granted
   * for this session are skipped — restoring them would require a user
   * gesture per workspace.
   */
  const handleDownloadAllWorkspaces = useCallback(async () => {
    try {
      const [{ MemoryContentContainer }, { containerToZip }] = await Promise.all([
        import('@bendyline/squisq/storage'),
        import('@bendyline/squisq-formats/container'),
      ]);

      const electron = isElectronHost();
      const all = await listWorkspaces();
      const candidates = all.filter((w) =>
        electron ? w.type === 'electron-native' : w.type !== 'electron-native',
      );
      if (candidates.length === 0) {
        alert('No workspaces to download.');
        return;
      }

      const container = new MemoryContentContainer();
      const usedFolders = new Set<string>();
      const skipped: string[] = [];

      for (const ws of candidates) {
        let p: FileSystemProvider | null = null;
        try {
          if (ws.type === 'electron-native') {
            p = await createElectronProviderFromWorkspace(ws);
          } else if (ws.type === 'native') {
            // Restore without prompting — only succeeds when the browser
            // still remembers the granted handle for this origin/session.
            p = await restoreNativeFolder(ws.id);
          } else {
            p = new IndexedDBFileSystemProvider(ws.id, ws.name);
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

        await copyProviderToContainer(p, container, folder);
      }

      if (usedFolders.size === 0) {
        alert('No workspaces could be opened for download.');
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
        alert(
          `Downloaded ${usedFolders.size} workspace(s). Skipped ${skipped.length} that require re-granting access: ${skipped.join(', ')}.`,
        );
      }
    } catch (err) {
      console.error('Failed to download all workspaces', err);
      alert('Failed to download all workspaces. See console for details.');
    }
  }, [copyProviderToContainer]);

  const handleKeepBrowserData = useCallback(async () => {
    if (typeof navigator === 'undefined') return;

    const storage = navigator.storage;
    if (!storage || typeof storage.persist !== 'function') {
      alert(
        'This browser does not support persistent storage requests. Please back up browser docs frequently.',
      );
      return;
    }

    try {
      const alreadyPersistent =
        typeof storage.persisted === 'function' ? await storage.persisted() : false;
      if (alreadyPersistent) {
        setBrowserStoragePersistent(true);
        alert('DocBlocks browser data is already marked as persistent by this browser.');
        return;
      }

      const granted = await storage.persist();
      if (granted) {
        setBrowserStoragePersistent(true);
        alert(
          'This browser will try to keep DocBlocks data for longer. Please still back up browser docs frequently.',
        );
      } else {
        alert(
          'This browser did not grant persistent storage for DocBlocks. Please back up browser docs frequently.',
        );
      }
    } catch {
      alert(
        'DocBlocks could not request persistent browser storage. Please back up browser docs frequently.',
      );
    }
  }, []);

  const handleRemoveWorkspace = useCallback(async () => {
    if (!activeWorkspaceId) return;
    const confirmMsg = isElectronHost()
      ? 'Remove this workspace from DocBlocks? The files on disk will not be deleted.'
      : 'Remove this workspace? This cannot be undone.';
    if (!confirm(confirmMsg)) return;

    const ws = await getWorkspace(activeWorkspaceId);
    if (ws?.type === 'electron-native') {
      try {
        await getDocBlocksHost().workspaces.unregister(activeWorkspaceId);
      } catch {
        // ignore — host cleanup is best-effort
      }
    } else {
      await removeDirectoryHandle(activeWorkspaceId);
    }
    await removeWorkspace(activeWorkspaceId);

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
      const p = new ElectronFileSystemProvider(info.id, info.name, info.rootPath);
      setProvider(p);
      setActiveWorkspaceId(info.id);
      setSelectedFile(null);
      setSelectedFolder(null);
      setFolderEntries([]);
      setEditorContent('');
      setEditorKey((k) => k + 1);
    } else {
      const defaultWs = await ensureDefaultWorkspace();
      const fsProvider = new IndexedDBFileSystemProvider(defaultWs.id, defaultWs.name);
      setProvider(fsProvider);
      setActiveWorkspaceId(defaultWs.id);
      setSelectedFile(null);
      setSelectedFolder(null);
      setFolderEntries([]);
      setEditorContent('');
      setEditorKey((k) => k + 1);
    }
  }, [activeWorkspaceId, handleWorkspaceSelect]);

  return (
    <div
      className={`db-shell${effectiveCompact ? ' db-shell--mobile' : ''}`}
      data-theme={resolvedTheme}
    >
      {saveToastVisible && (
        <div className="db-save-toast" role="status" aria-live="polite">
          Autosaved. You're all set.
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
        {/* Left sidebar — hidden in compact layout when the editor is
            showing (compact = real mobile narrow viewport OR the user
            dragged the resizer below SIDEBAR_COLLAPSE_THRESHOLD). */}
        {(!effectiveCompact || !mobileShowEditor) && (
          <div
            ref={sidebarRef}
            className="db-shell-sidebar"
            style={effectiveCompact ? undefined : { width: `${sidebarWidth}px` }}
          >
            <div className="db-shell-sidebar-header">
              <AppMenu
                logoUrl={logoUrl}
                themePreference={themePreference}
                onThemeChange={handleThemeChange}
                versioningPreference={versioningPreference}
                onVersioningPreferenceChange={handleVersioningPreferenceChange}
                onDownloadAllWorkspaces={handleDownloadAllWorkspaces}
                onKeepBrowserData={
                  showBrowserStorageWarning && !browserStoragePersistent
                    ? handleKeepBrowserData
                    : undefined
                }
              />
              <WorkspacePicker
                activeWorkspaceId={activeWorkspaceId}
                onSelect={handleWorkspaceSelect}
                onOpenFolder={handleOpenFolder}
              />
              <WorkspaceSettingsButton
                onSettings={handleOpenWorkspaceSettings}
                onRename={handleRenameWorkspace}
                onDownload={handleDownloadWorkspace}
                onRemove={handleRemoveWorkspace}
              />
            </div>
            <FileExplorer
              key={explorerKey}
              provider={provider}
              onSelect={handleSelect}
              onTreeChange={handleTreeChange}
              onImportFiles={handleImportFiles}
            />
            <div className="db-shell-sidebar-footer">
              <a
                href="https://github.com/bendyline/docblocks/blob/main/LICENSE"
                target="_blank"
                rel="noopener noreferrer"
              >
                Terms of Use
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
                    title="Browser docs can get auto-removed. Download all workspaces."
                  >
                    Backup browser docs frequently
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Resize handle between sidebar and editor — hidden whenever
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

        {/* Editor area — hidden in compact layout when the sidebar is showing. */}
        {(!effectiveCompact || mobileShowEditor) && (
          <div
            style={{
              flex: 1,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              position: 'relative',
            }}
          >
            {selectedFile && mediaProvider ? (
              <MediaContext.Provider value={mediaProvider}>
                <EditorShell
                  key={`${selectedFile}-${editorKey}`}
                  initialMarkdown={editorContent}
                  initialView={initialView}
                  articleId={selectedFile}
                  fileName={selectedFile}
                  onChange={handleEditorChange}
                  colorScheme={resolvedTheme}
                  height="100%"
                  outlineWidth={280}
                  mediaProvider={mediaProvider}
                  documentLinkProvider={documentLinkProvider}
                  container={versionsContainer ?? undefined}
                  allowVersioning={effectiveVersioning}
                  viewPreferences={viewPreferences}
                  onViewPreferencesChange={handleViewPreferencesChange}
                  versionBasename={versionBasename ?? stripExtension(basenameOf(selectedFile))}
                  versioningPrunePolicy={versioningPrunePolicy}
                  versioningAutoSaveIdleMs={versioningAutoSaveIdleMs}
                  onSaveVersion={onSaveVersion}
                  toolbarSlotLeft={
                    effectiveCompact ? (
                      <button
                        className="db-mobile-back"
                        onClick={() => setMobileShowEditor(false)}
                        aria-label="Show file list"
                      >
                        <span className="db-mobile-back-arrow">&larr;</span>
                      </button>
                    ) : undefined
                  }
                  toolbarSlotRight={
                    <>
                      {/* Restore split view — only relevant when compact
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
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
                            <line x1="6" y1="2.5" x2="6" y2="13.5" />
                          </svg>
                        </button>
                      )}
                      <ExportToolbarControls
                        selectedFile={selectedFile}
                        mediaContainer={mediaContainerRef.current}
                      />
                    </>
                  }
                />
                {showWelcomeGateway && (
                  <div className="db-welcome-gateway" role="note" aria-label="Welcome tip">
                    <span className="db-welcome-gateway-text">
                      You&rsquo;re watching this welcome doc in <strong>Play</strong> view —
                      it&rsquo;s a regular markdown file, and so is everything you&rsquo;ll write.
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
              </MediaContext.Provider>
            ) : selectedFolder ? (
              <div className="db-folder-view">
                {effectiveCompact && (
                  <button className="db-mobile-back" onClick={() => setMobileShowEditor(false)}>
                    <span className="db-mobile-back-arrow">&larr;</span>
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
              <div className="db-shell-empty">
                {effectiveCompact && (
                  <button className="db-mobile-back" onClick={() => setMobileShowEditor(false)}>
                    <span className="db-mobile-back-arrow">&larr;</span>
                    Back to files
                  </button>
                )}
                <p>Select a file to start editing, or create a new one.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
