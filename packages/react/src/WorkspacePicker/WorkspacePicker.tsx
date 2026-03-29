/**
 * WorkspacePicker — dropdown for switching between workspaces
 * (IndexedDB-based or native folder via File System Access API).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { WorkspaceDescriptor } from '@bendyline/docblocks/workspace';
import { listWorkspaces, saveWorkspace, touchWorkspace } from '@bendyline/docblocks/workspace';
import { isNativeFileSystemSupported } from '@bendyline/docblocks/filesystem';

export interface WorkspacePickerProps {
  /** Currently active workspace id. */
  activeWorkspaceId: string | null;
  /** Called when the user picks a different workspace. */
  onSelect: (descriptor: WorkspaceDescriptor) => void;
  /** Called when the user chooses "Open Folder" (native FS). */
  onOpenFolder: () => void;
  /** Optional className. */
  className?: string;
}

export function WorkspacePicker({
  activeWorkspaceId,
  onSelect,
  onOpenFolder,
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

  const refresh = useCallback(async () => {
    const list = await listWorkspaces();
    setWorkspaces(list);
  }, []);

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

  return (
    <div ref={pickerRef} className={`db-workspace-picker ${className ?? ''}`}>
      <button
        className="db-workspace-picker-btn"
        onClick={() => setIsOpen(!isOpen)}
        title="Switch workspace"
      >
        {activeWs?.name ?? 'No workspace'}
        <span className="db-workspace-picker-caret">{isOpen ? '\u25B4' : '\u25BE'}</span>
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
              {ws.name}
              <span className="db-workspace-type">{ws.type === 'native' ? '(folder)' : ''}</span>
            </button>
          ))}

          <div className="db-workspace-dropdown-divider" />

          <button className="db-workspace-dropdown-item" onClick={handleCreateNew}>
            + New Workspace
          </button>

          {isNativeFileSystemSupported() && (
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
        </div>
      )}
    </div>
  );
}
