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
import { createMediaProviderFromContainer } from '@bendyline/squisq/storage';
import type { FileSystemProvider, FileSystemEntry } from '@bendyline/docblocks/filesystem';
import {
  IndexedDBFileSystemProvider,
  IndexedDBContentContainer,
  openNativeFolder,
  restoreNativeFolder,
  removeDirectoryHandle,
} from '@bendyline/docblocks/filesystem';
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

export function DocBlocksShell({ theme: themeProp = 'auto', logoUrl }: DocBlocksShellProps) {
  const osTheme = useOsTheme();
  const [themePreference, setThemePreference] = useState<ThemePreference>(loadThemePreference);
  // User setting overrides the component prop
  const effectiveTheme = themePreference !== 'auto' ? themePreference : themeProp;
  const resolvedTheme: 'light' | 'dark' = effectiveTheme === 'auto' ? osTheme : effectiveTheme;

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

  /** Persistent media container backed by IndexedDB (survives page refresh). */
  const mediaContainerRef = useRef<IndexedDBContentContainer | null>(null);
  const [mediaProvider, setMediaProvider] = useState<MediaProvider | null>(null);

  /** Set up persistent media container for a workspace. */
  const setupMediaContainer = useCallback((workspaceId: string) => {
    const mc = new IndexedDBContentContainer(workspaceId);
    mediaContainerRef.current = mc;
    setMediaProvider(createMediaProviderFromContainer(mc));
  }, []);

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
      if (ws.type === 'native') {
        const restored = await restoreNativeFolder(ws.id);
        if (!restored) return null;
        fsProvider = restored;
      } else {
        fsProvider = new IndexedDBFileSystemProvider(ws.id, ws.name);
      }
      await touchWorkspace(ws.id);
      setProvider(fsProvider);
      setActiveWorkspaceId(ws.id);

      setupMediaContainer(ws.id);

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
    [pushHash, setupMediaContainer],
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

      const workspaces = await listWorkspaces();
      // Pick the most recently opened workspace
      const sorted = [...workspaces].sort((a, b) =>
        (b.lastOpened ?? '').localeCompare(a.lastOpened ?? ''),
      );
      for (const ws of sorted) {
        if (ws.type === 'native') {
          const restored = await restoreNativeFolder(ws.id);
          if (restored) {
            await touchWorkspace(ws.id);
            fsProvider = restored;
            setProvider(restored);
            setActiveWorkspaceId(ws.id);

            setupMediaContainer(ws.id);
            break;
          }
        } else {
          const p = new IndexedDBFileSystemProvider(ws.id, ws.name);
          await touchWorkspace(ws.id);
          fsProvider = p;
          setProvider(p);
          setActiveWorkspaceId(ws.id);

          setupMediaContainer(ws.id);
          break;
        }
      }

      if (!fsProvider) {
        // No workspaces yet — create default
        const defaultWs = await ensureDefaultWorkspace();
        const p = new IndexedDBFileSystemProvider(defaultWs.id, defaultWs.name);
        fsProvider = p;
        setProvider(p);
        setActiveWorkspaceId(defaultWs.id);

        setupMediaContainer(defaultWs.id);
      }

      // Set initial hash
      pushHash(fsProvider.id, null);

      // Seed welcome file if workspace is empty
      await seedWelcomeFile(fsProvider);
    })();
  }, [openFromIds, pushHash, seedWelcomeFile, setupMediaContainer]);

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

  const handleWorkspaceSelect = useCallback(
    async (ws: WorkspaceDescriptor) => {
      await touchWorkspace(ws.id);
      if (ws.type === 'native') {
        const restored = await restoreNativeFolder(ws.id);
        if (restored) {
          setProvider(restored);
        } else {
          // Permission denied or handle lost — fall through without changing provider
          return;
        }
      } else {
        setProvider(new IndexedDBFileSystemProvider(ws.id, ws.name));
      }
      setActiveWorkspaceId(ws.id);
      setSelectedFile(null);
      setSelectedFolder(null);
      setFolderEntries([]);
      setEditorContent('');
      setEditorKey((k) => k + 1);
      pushHash(ws.id, null);

      setupMediaContainer(ws.id);
    },
    [pushHash, setupMediaContainer],
  );

  const handleOpenFolder = useCallback(async () => {
    try {
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

      setupMediaContainer(descriptor.id);
    } catch {
      // User cancelled or API not supported
    }
  }, [pushHash, setupMediaContainer]);

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

  /** Copy non-markdown files from an imported container into persistent media storage. */
  const persistContainerMedia = useCallback(
    async (source: {
      listFiles(): Promise<Array<{ path: string; mimeType: string }>>;
      readFile(path: string): Promise<ArrayBuffer | null>;
    }) => {
      const mc = mediaContainerRef.current;
      if (!mc) return;
      const entries = await source.listFiles();
      for (const entry of entries) {
        if (entry.path.endsWith('.md')) continue;
        const data = await source.readFile(entry.path);
        if (data) {
          await mc.writeFile(entry.path, new Uint8Array(data), entry.mimeType);
        }
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
            await persistContainerMedia(container);
          } else if (ext === '.pdf') {
            const { pdfToContainer } = await import('@bendyline/squisq-formats/pdf');
            const container = await pdfToContainer(await file.arrayBuffer());
            markdown = (await container.readDocument()) ?? '';
            await persistContainerMedia(container);
          } else if (ext === '.dbk' || ext === '.zip') {
            const { zipToContainer } = await import('@bendyline/squisq-formats/container');
            const container = await zipToContainer(await file.arrayBuffer());
            markdown = (await container.readDocument()) ?? '';
            await persistContainerMedia(container);
          } else {
            continue;
          }

          await provider.writeFile(destPath, markdown);
        } catch (err) {
          console.error(`Failed to import ${file.name}:`, err);
        }
      }
      // Refresh media provider once after all imports (not per-file)
      const mc = mediaContainerRef.current;
      if (mc) {
        setMediaProvider(createMediaProviderFromContainer(mc));
      }
      // Refresh file tree
      setExplorerKey((k) => k + 1);
    },
    [provider, persistContainerMedia],
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
  }, [activeWorkspaceId, provider]);

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
    if (!confirm('Remove this workspace? This cannot be undone.')) return;
    await removeDirectoryHandle(activeWorkspaceId);
    await removeWorkspace(activeWorkspaceId);
    // Switch to most recent remaining workspace or create default
    const remaining = await listWorkspaces();
    if (remaining.length > 0) {
      const next = remaining[0];
      await handleWorkspaceSelect(next);
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

      setupMediaContainer(defaultWs.id);
    }
  }, [activeWorkspaceId, handleWorkspaceSelect, setupMediaContainer]);

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
                  <span className="db-folder-view-icon">📁</span>
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
                          {entry.kind === 'directory' ? '📁' : '📄'}
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
