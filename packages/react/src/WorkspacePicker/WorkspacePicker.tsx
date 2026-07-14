/**
 * WorkspacePicker — dropdown for switching between workspaces
 * (IndexedDB-based or native folder via File System Access API).
 */

import { Fragment, useState, useEffect, useCallback, useRef } from 'react';
import type { WorkspaceDescriptor } from '@bendyline/docblocks/workspace';
import { listWorkspaces, saveWorkspace, touchWorkspace } from '@bendyline/docblocks/workspace';
import { isElectronHost } from '@bendyline/docblocks/host';
import { FolderIcon, NewFolderIcon } from '../icons.js';

function isNativeFileSystemSupported(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  );
}

export interface WorkspacePickerProps {
  /** Currently active workspace id. */
  activeWorkspaceId: string | null;
  /** Called when the user picks a different workspace. */
  onSelect: (descriptor: WorkspaceDescriptor) => void;
  /** Called when the user chooses "Open Folder" (native FS). */
  onOpenFolder: () => void;
  /**
   * Called when the user chooses "Clone Git repository". Only provided on
   * the desktop when git is available — omitted, the item is hidden.
   */
  onCloneRepository?: () => void;
  /** Optional className. */
  className?: string;
}

function WorkspacePath({ path }: { path: string }) {
  return path.split(/([\\/])/).map((segment, index) => (
    <Fragment key={index}>
      {segment}
      {(segment === '\\' || segment === '/') && <wbr />}
    </Fragment>
  ));
}

export function WorkspacePicker({
  activeWorkspaceId,
  onSelect,
  onOpenFolder,
  onCloneRepository,
  className,
}: WorkspacePickerProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceDescriptor[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return;
    function handleOutsideClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [isOpen]);

  const electron = isElectronHost();

  const refresh = useCallback(async () => {
    const list = await listWorkspaces();
    // On desktop, hide web-only workspaces (indexeddb/native).
    const filtered = electron
      ? list.filter((w) => w.type === 'electron-native')
      : list.filter((w) => w.type !== 'electron-native');
    setWorkspaces(filtered);
  }, [electron]);

  useEffect(() => {
    refresh();
  }, [refresh, activeWorkspaceId]);

  const handleSelect = useCallback(
    async (ws: WorkspaceDescriptor) => {
      await touchWorkspace(ws.id);
      onSelect(ws);
      setIsOpen(false);
    },
    [onSelect],
  );

  const handleCreateNew = useCallback(async () => {
    const name = `Workspace ${workspaces.length + 1}`;
    const id = `ws-${Date.now()}`;
    const descriptor: WorkspaceDescriptor = {
      id,
      name,
      type: 'indexeddb',
      lastOpened: new Date().toISOString(),
    };
    await saveWorkspace(descriptor);
    await refresh();
    onSelect(descriptor);
    setIsOpen(false);
  }, [workspaces.length, onSelect, refresh]);

  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId);
  const activeWorkspaceName = activeWs?.name ?? 'No workspace';

  return (
    <div ref={pickerRef} className={`db-workspace-picker ${className ?? ''}`}>
      <button
        className="db-workspace-picker-btn"
        onClick={() => setIsOpen(!isOpen)}
        title="Switch workspace"
        aria-label={`Switch workspace, current: ${activeWorkspaceName}`}
      >
        <span className="db-workspace-picker-label">{activeWorkspaceName}</span>
        <span className="db-workspace-picker-compact-icon">
          <FolderIcon />
        </span>
        <span
          className={`db-workspace-picker-caret${isOpen ? ' db-workspace-picker-caret--open' : ''}`}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <div className="db-workspace-dropdown">
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              className={`db-workspace-dropdown-item ${
                ws.id === activeWorkspaceId ? 'db-workspace-dropdown-item--active' : ''
              }`}
              onClick={() => handleSelect(ws)}
            >
              <span className="db-workspace-details">
                <span className="db-workspace-heading">
                  <span>{ws.name}</span>
                  {(ws.type === 'native' || ws.type === 'electron-native') && (
                    <span className="db-workspace-type">(folder)</span>
                  )}
                </span>
                {ws.rootPath && (
                  <span className="db-workspace-path" title={ws.rootPath}>
                    <WorkspacePath path={ws.rootPath} />
                  </span>
                )}
              </span>
            </button>
          ))}

          <div className="db-workspace-dropdown-divider" />

          {!electron && (
            <button className="db-workspace-dropdown-item" onClick={handleCreateNew}>
              <span className="db-workspace-dropdown-action-label">
                <NewFolderIcon />
                <span>New Workspace</span>
              </span>
            </button>
          )}

          {(electron || isNativeFileSystemSupported()) && (
            <button
              className="db-workspace-dropdown-item"
              onClick={() => {
                setIsOpen(false);
                onOpenFolder();
              }}
            >
              Open Folder...
            </button>
          )}

          {onCloneRepository && (
            <button
              className="db-workspace-dropdown-item"
              onClick={() => {
                setIsOpen(false);
                onCloneRepository();
              }}
            >
              Clone Git Repository...
            </button>
          )}
        </div>
      )}
    </div>
  );
}
