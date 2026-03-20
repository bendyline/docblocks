/**
 * DocBlocksShell — top-level layout component.
 *
 * Composes the left sidebar (WorkspacePicker + FileExplorer) with
 * the center editor area (squisq EditorShell).
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { EditorShell } from '@bendyline/squisq-editor-react';
import type { EditorTheme } from '@bendyline/squisq-editor-react';
import '@bendyline/squisq-editor-react/styles';
import { MediaContext } from '@bendyline/squisq-react';
import type { MediaProvider } from '@bendyline/squisq/schemas';
import {
  createMediaProviderFromContainer,
  MemoryContentContainer,
} from '@bendyline/squisq/storage';
import type { FileSystemProvider, FileSystemEntry } from '@bendyline/docblocks/filesystem';
import {
  IndexedDBFileSystemProvider,
  openNativeFolder,
} from '@bendyline/docblocks/filesystem';
import type { WorkspaceDescriptor } from '@bendyline/docblocks/workspace';
import {
  ensureDefaultWorkspace,
  saveWorkspace,
  touchWorkspace,
} from '@bendyline/docblocks/workspace';
import { FileExplorer } from '../FileExplorer/FileExplorer.js';
import { WorkspacePicker } from '../WorkspacePicker/WorkspacePicker.js';
import { useAutoSave } from '../hooks/useAutoSave.js';

export interface DocBlocksShellProps {
  /** Optional theme override. Omit or pass 'auto' to follow OS preference. */
  theme?: EditorTheme | 'auto';
}

function useOsTheme(): 'light' | 'dark' {
  const [dark, setDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return dark ? 'dark' : 'light';
}

export function DocBlocksShell({ theme = 'auto' }: DocBlocksShellProps) {
  const osTheme = useOsTheme();
  const resolvedTheme: 'light' | 'dark' = theme === 'auto' ? osTheme : theme;
  const [provider, setProvider] = useState<FileSystemProvider | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [folderEntries, setFolderEntries] = useState<FileSystemEntry[]>([]);
  const [editorContent, setEditorContent] = useState('');
  const [editorKey, setEditorKey] = useState(0);

  /** MediaProvider backed by an in-memory container. */
  const mediaProvider = useMemo<MediaProvider>(
    () => createMediaProviderFromContainer(new MemoryContentContainer()),
    [],
  );

  // Initialise default workspace on mount
  useEffect(() => {
    (async () => {
      const defaultWs = await ensureDefaultWorkspace();
      const fsProvider = new IndexedDBFileSystemProvider(defaultWs.id, defaultWs.name);
      setProvider(fsProvider);
      setActiveWorkspaceId(defaultWs.id);
    })();
  }, []);

  // Auto-save current file
  useAutoSave(provider, selectedFile, editorContent);

  const handleWorkspaceSelect = useCallback(async (ws: WorkspaceDescriptor) => {
    await touchWorkspace(ws.id);
    if (ws.type === 'indexeddb') {
      setProvider(new IndexedDBFileSystemProvider(ws.id, ws.name));
    }
    setActiveWorkspaceId(ws.id);
    setSelectedFile(null);
    setSelectedFolder(null);
    setFolderEntries([]);
    setEditorContent('');
    setEditorKey((k) => k + 1);
  }, []);

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
    } catch {
      // User cancelled or API not supported
    }
  }, []);

  const handleSelect = useCallback(
    async (path: string, kind: 'file' | 'directory') => {
      if (!provider) return;

      if (kind === 'directory') {
        setSelectedFile(null);
        setSelectedFolder(path);
        const entries = await provider.readDirectory(path);
        setFolderEntries(entries);
        setEditorContent('');
        setEditorKey((k) => k + 1);
      } else {
        const content = await provider.readFile(path);
        setSelectedFile(path);
        setSelectedFolder(null);
        setFolderEntries([]);
        setEditorContent(content ?? '');
        setEditorKey((k) => k + 1);
      }
    },
    [provider],
  );

  const handleTreeChange = useCallback(async () => {
    if (!provider || !selectedFolder) return;
    const entries = await provider.readDirectory(selectedFolder);
    setFolderEntries(entries);
  }, [provider, selectedFolder]);

  const handleEditorChange = useCallback((source: string) => {
    setEditorContent(source);
  }, []);

  const isDark = resolvedTheme === 'dark';

  return (
    <div
      className="db-shell"
      data-theme={resolvedTheme}
    >
      {/* Main area */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left sidebar */}
        <div className="db-shell-sidebar">
          <WorkspacePicker
            activeWorkspaceId={activeWorkspaceId}
            onSelect={handleWorkspaceSelect}
            onOpenFolder={handleOpenFolder}
          />
          <FileExplorer provider={provider} onSelect={handleSelect} onTreeChange={handleTreeChange} />
        </div>

        {/* Editor area */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {selectedFile ? (
            <MediaContext.Provider value={mediaProvider}>
              <EditorShell
                key={`${selectedFile}-${editorKey}`}
                initialMarkdown={editorContent}
                articleId={selectedFile}
                onChange={handleEditorChange}
                theme={resolvedTheme}
                height="100%"
              />
            </MediaContext.Provider>
          ) : selectedFolder ? (
            <div className="db-folder-view">
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
      </div>
    </div>
  );
}
