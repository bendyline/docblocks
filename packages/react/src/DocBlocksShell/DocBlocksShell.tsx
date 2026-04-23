/**
 * DocBlocksShell — top-level layout component.
 *
 * Composes the left sidebar (WorkspacePicker + FileExplorer) with
 * the center editor area (squisq EditorShell).
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { EditorShell } from '@bendyline/squisq-editor-react';
import type { EditorTheme, EditorView } from '@bendyline/squisq-editor-react';
import '@bendyline/squisq-editor-react/styles';
import { MediaContext } from '@bendyline/squisq-react';
import type { MediaProvider } from '@bendyline/squisq/schemas';
import type { FileSystemProvider, FileSystemEntry } from '@bendyline/docblocks/filesystem';
import {
  IndexedDBFileSystemProvider,
  ElectronFileSystemProvider,
  FileSystemContentContainer,
  createFileMediaProvider,
  openNativeFolder,
  restoreNativeFolder,
  removeDirectoryHandle,
} from '@bendyline/docblocks/filesystem';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { isElectronHost, getDocblocksHost } from '@bendyline/docblocks/host';
import type { WorkspaceDescriptor } from '@bendyline/docblocks/workspace';
import {
  ensureDefaultWorkspace,
  getWorkspace,
  listWorkspaces,
  removeWorkspace,
  saveWorkspace,
  touchWorkspace,
} from '@bendyline/docblocks/workspace';
import { AppMenu, type ThemePreference } from '../AppMenu/AppMenu.js';
import { FileExplorer } from '../FileExplorer/FileExplorer.js';
import { WorkspacePicker } from '../WorkspacePicker/WorkspacePicker.js';
import { WorkspaceSettingsButton } from '../WorkspacePicker/WorkspaceSettingsButton.js';
import { useAutoSave } from '../hooks/useAutoSave.js';
import { ExportToolbarControls } from '../Export/ExportToolbarControls.js';

export interface DocBlocksShellProps {
  /** Optional theme override. Omit or pass 'auto' to follow OS preference. */
  theme?: EditorTheme | 'auto';
  /** Optional logo image URL for the app menu. */
  logoUrl?: string;
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

export function DocBlocksShell({ theme: _themeProp = 'auto', logoUrl }: DocBlocksShellProps) {
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
  const isMobile = useIsMobile();
  const [mobileShowEditor, setMobileShowEditor] = useState(false);
  const [provider, setProvider] = useState<FileSystemProvider | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [folderEntries, setFolderEntries] = useState<FileSystemEntry[]>([]);
  const [editorContent, setEditorContent] = useState('');
  const [editorKey, setEditorKey] = useState(0);
  const [explorerKey, setExplorerKey] = useState(0);
  const [initialView, setInitialView] = useState<EditorView>('wysiwyg');
  /** Suppress popstate handling during programmatic navigation. */
  const skipPopState = useRef(false);

  /**
   * Per-file media container: for `notes.md`, images live in
   * `notes_files/` next to the markdown. Created lazily on first write,
   * picked up automatically if it already exists. Set up by the effect
   * below whenever the selected file (or backing provider) changes.
   */
  const mediaContainerRef = useRef<ContentContainer | null>(null);
  const [mediaProvider, setMediaProvider] = useState<MediaProvider | null>(null);

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
      const workspaces = await listWorkspaces();
      const ws = workspaces.find((w) => w.id === wsId);
      if (!ws) return null;

      let fsProvider: FileSystemProvider | null = null;
      if (ws.type === 'electron-native') {
        if (!ws.rootPath) return null;
        await getDocblocksHost().workspaces.register({
          id: ws.id,
          name: ws.name,
          rootPath: ws.rootPath,
        });
        fsProvider = new ElectronFileSystemProvider(ws.id, ws.name, ws.rootPath);
      } else if (ws.type === 'native') {
        const restored = await restoreNativeFolder(ws.id);
        if (!restored) return null;
        fsProvider = restored;
      } else {
        fsProvider = new IndexedDBFileSystemProvider(ws.id, ws.name);
      }
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
          saveLastState({ workspaceId: wsId, filePath, view: effectiveView });
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

      // If the only file is the welcome doc, auto-select it
      if (
        entries.length === 1 &&
        entries[0].kind === 'file' &&
        entries[0].path.replace(/^\//, '') === 'aboutDocblocks.md'
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
        }
        return;
      }

      if (entries.length > 0) return;

      const welcomePath = '/aboutDocblocks.md';
      const welcomeContent = [
        '# Welcome to DocBlocks',
        '',
        'DocBlocks is a browser-based markdown document editor that lets you create, organize, and manage your documents right in the browser.',
        '',
        '## Features',
        '',
        '- **Rich Markdown Editing** — Write in a visual editor or switch to raw markdown anytime',
        '- **Workspaces** — Organize your documents into separate workspaces',
        '- **Playback & Video** — Preview your documents as rich visual presentations and export them as MP4 video',
        '- **Export Anywhere** — Export documents to PDF, Word, PowerPoint, HTML, or Markdown with theme options',
        '- **Local Storage** — Your documents are stored in your browser using temporary browser storage (backup often!)',
        '- **Device Folders** — Create workspaces based on folders on your computer',
        '- **No BS** — Free, no ads, no accounts, no tracking - everything runs locally in your browser',
        '',
        '## Getting Started',
        '',
        '1. Create a new file using the **New File** button in the sidebar',
        '2. Start writing in markdown — the editor supports headings, lists, links, images, and more',
        '3. Your work is saved automatically',
        '',
        'Built with [Squiggly Square](https://github.com/nicoth-in/squisq) by [Bendyline](https://bendyline.com).',
      ].join('\n');

      await fs.writeFile(welcomePath, welcomeContent);
      setSelectedFile(welcomePath);
      setEditorContent(welcomeContent);
      setInitialView('preview');
      setEditorKey((k) => k + 1);
      setExplorerKey((k) => k + 1);
      pushHash(fs.id, welcomePath);
      saveLastState({ workspaceId: fs.id, filePath: welcomePath, view: 'preview' });
    },
    [pushHash],
  );

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
          if (!ws.rootPath) continue;
          await getDocblocksHost().workspaces.register({
            id: ws.id,
            name: ws.name,
            rootPath: ws.rootPath,
          });
          const p = new ElectronFileSystemProvider(ws.id, ws.name, ws.rootPath);
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
          const info = await getDocblocksHost().workspaces.getDefault();
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

  // Track view mode changes (Editor/Raw/Play tabs) and persist to localStorage
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest?.('[data-view]');
      if (target) {
        const view = target.getAttribute('data-view') as EditorView;
        if (view && activeWorkspaceId && selectedFile) {
          saveLastState({ workspaceId: activeWorkspaceId, filePath: selectedFile, view });
        }
      }
    };
    window.addEventListener('click', handler, true);
    return () => window.removeEventListener('click', handler, true);
  }, [activeWorkspaceId, selectedFile]);

  // Auto-save current file
  useAutoSave(provider, selectedFile, editorContent);

  // Per-file media: for `notes.md` images live in `notes_files/` beside it.
  // Rebuilds whenever the provider or selected file changes.
  useEffect(() => {
    if (!provider || !selectedFile) {
      mediaContainerRef.current = null;
      setMediaProvider(null);
      return;
    }
    const parentDir = dirnameOf(selectedFile);
    const base = basenameOf(selectedFile);
    const container = new FileSystemContentContainer(provider, parentDir);
    const mp = createFileMediaProvider(container, base);
    mediaContainerRef.current = container;
    setMediaProvider(mp);
    return () => {
      mp.dispose();
    };
  }, [provider, selectedFile]);

  // React to external file changes watched by the Electron host (chokidar).
  useEffect(() => {
    if (!isElectronHost()) return;
    if (!provider || !(provider instanceof ElectronFileSystemProvider)) return;
    const unwatch = provider.watch(() => {
      setExplorerKey((k) => k + 1);
      // If the open file's contents changed on disk, reload it (best-effort).
      if (selectedFile) {
        (async () => {
          const content = await provider.readFile(selectedFile);
          if (content !== null && content !== editorContent) {
            setEditorContent(content);
            setEditorKey((k) => k + 1);
          }
        })();
      }
    });
    return unwatch;
  }, [provider, selectedFile, editorContent]);

  const handleWorkspaceSelect = useCallback(
    async (ws: WorkspaceDescriptor) => {
      await touchWorkspace(ws.id);
      let nextProvider: FileSystemProvider | null = null;
      if (ws.type === 'electron-native') {
        if (!ws.rootPath) return;
        await getDocblocksHost().workspaces.register({
          id: ws.id,
          name: ws.name,
          rootPath: ws.rootPath,
        });
        nextProvider = new ElectronFileSystemProvider(ws.id, ws.name, ws.rootPath);
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
        const info = await getDocblocksHost().workspaces.pickFolder();
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
    if (activeWorkspaceId) {
      pushHash(activeWorkspaceId, '/' + filename);
    }
  }, [provider, activeWorkspaceId, pushHash]);

  const handleRevealWorkspace = useCallback(async () => {
    if (!isElectronHost() || !activeWorkspaceId) return;
    const ws = await getWorkspace(activeWorkspaceId);
    if (ws?.type === 'electron-native' && ws.rootPath) {
      await getDocblocksHost().shell.revealInFolder(ws.rootPath);
    }
  }, [activeWorkspaceId]);

  // Subscribe to native menu commands (Electron host).
  useEffect(() => {
    if (!isElectronHost()) return;
    const host = getDocblocksHost();
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

  // Subscribe to open-file / deep-link requests from the OS.
  useEffect(() => {
    if (!isElectronHost()) return;
    const host = getDocblocksHost();
    return host.onOpenRequest(async (req) => {
      if (req.filePath) {
        const workspaces = (await listWorkspaces()).filter(
          (w) => w.type === 'electron-native' && w.rootPath,
        );
        const match = workspaces.find(
          (w) => req.filePath!.startsWith((w.rootPath ?? '') + '/') || req.filePath === w.rootPath,
        );
        if (match && match.rootPath) {
          const rel = '/' + req.filePath.slice(match.rootPath.length).replace(/^\/+/, '');
          await openFromIds(match.id, rel, true);
        }
      } else if (req.url) {
        try {
          const u = new URL(req.url);
          const path = u.searchParams.get('path');
          if (path) {
            const workspaces = (await listWorkspaces()).filter(
              (w) => w.type === 'electron-native' && w.rootPath,
            );
            const match = workspaces.find(
              (w) => path.startsWith((w.rootPath ?? '') + '/') || path === w.rootPath,
            );
            if (match && match.rootPath) {
              const rel = '/' + path.slice(match.rootPath.length).replace(/^\/+/, '');
              await openFromIds(match.id, rel, true);
            }
          }
        } catch {
          // bad URL, ignore
        }
      }
    });
  }, [openFromIds]);

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
        pushHash(activeWorkspaceId, path);
        saveLastState({ workspaceId: activeWorkspaceId, filePath: path, view: 'wysiwyg' });
        if (isMobile) setMobileShowEditor(true);
      }
    },
    [provider, activeWorkspaceId, pushHash, isMobile],
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

  const handleDownloadWorkspace = useCallback(async () => {
    if (!provider) return;
    try {
      const entries = await provider.readDirectory('/');
      const lines: string[] = [];
      for (const entry of entries) {
        if (entry.kind === 'file') {
          const content = await provider.readFile(entry.path);
          lines.push(`--- ${entry.path} ---\n${content ?? ''}\n`);
        }
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'workspace.txt';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }, [provider]);

  const handleRemoveWorkspace = useCallback(async () => {
    if (!activeWorkspaceId) return;
    const confirmMsg = isElectronHost()
      ? 'Remove this workspace from DocBlocks? The files on disk will not be deleted.'
      : 'Remove this workspace? This cannot be undone.';
    if (!confirm(confirmMsg)) return;

    const ws = await getWorkspace(activeWorkspaceId);
    if (ws?.type === 'electron-native') {
      try {
        await getDocblocksHost().workspaces.unregister(activeWorkspaceId);
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
      const info = await getDocblocksHost().workspaces.getDefault();
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
    <div className={`db-shell${isMobile ? ' db-shell--mobile' : ''}`} data-theme={resolvedTheme}>
      {/* Main area */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left sidebar — hidden on mobile when editor is shown */}
        {(!isMobile || !mobileShowEditor) && (
          <div className="db-shell-sidebar">
            <div className="db-shell-sidebar-header">
              <AppMenu
                logoUrl={logoUrl}
                themePreference={themePreference}
                onThemeChange={handleThemeChange}
              />
              <WorkspacePicker
                activeWorkspaceId={activeWorkspaceId}
                onSelect={handleWorkspaceSelect}
                onOpenFolder={handleOpenFolder}
              />
              <WorkspaceSettingsButton
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
            </div>
          </div>
        )}

        {/* Editor area — hidden on mobile when sidebar is shown */}
        {(!isMobile || mobileShowEditor) && (
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {selectedFile && mediaProvider ? (
              <MediaContext.Provider value={mediaProvider}>
                <EditorShell
                  key={`${selectedFile}-${editorKey}`}
                  initialMarkdown={editorContent}
                  initialView={initialView}
                  articleId={selectedFile}
                  onChange={handleEditorChange}
                  theme={resolvedTheme}
                  height="100%"
                  mediaProvider={mediaProvider}
                  container={mediaContainerRef.current ?? undefined}
                  toolbarSlotLeft={
                    isMobile ? (
                      <button className="db-mobile-back" onClick={() => setMobileShowEditor(false)}>
                        <span className="db-mobile-back-arrow">&larr;</span>
                      </button>
                    ) : undefined
                  }
                  toolbarSlotRight={
                    <ExportToolbarControls
                      selectedFile={selectedFile}
                      mediaContainer={mediaContainerRef.current}
                    />
                  }
                />
              </MediaContext.Provider>
            ) : selectedFolder ? (
              <div className="db-folder-view">
                {isMobile && (
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
                <p>Select a file to start editing, or create a new one.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
