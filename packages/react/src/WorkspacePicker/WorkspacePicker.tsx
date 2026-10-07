/**
 * WorkspacePicker — dropdown for switching between workspaces
 * (IndexedDB-based or native folder via File System Access API).
 */

import { Fragment, useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import type { WorkspaceDescriptor } from '@bendyline/docblocks/workspace';
import { listWorkspaces, saveWorkspace, touchWorkspace } from '@bendyline/docblocks/workspace';
import { hostSupports } from '@bendyline/docblocks/host';
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
  /** Forces a list refresh after an external workspace-registry mutation. */
  refreshKey?: number;
  /** Optional className. */
  className?: string;
}

/** Keeps the dropdown this far inside the edges of whatever clips it. */
const DROPDOWN_EDGE_MARGIN = 4;

/** The horizontal extent of the nearest ancestor that clips `element`. */
function clippingBounds(element: HTMLElement): { left: number; right: number } {
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (getComputedStyle(ancestor).overflowX !== 'visible') {
      const rect = ancestor.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    }
  }
  return { left: 0, right: document.documentElement.clientWidth };
}

/**
 * Keep the dropdown inside the sidebar. It hangs from the picker, which sits
 * beside the logo, so anything wider than the picker — the New Workspace form
 * above all — ran past the sidebar's right edge. The sidebar clips, but a
 * browser still scrolls a clipping ancestor to reveal a focused field, so
 * focusing the name field shoved the whole sidebar about 67px sideways.
 * Narrow it if it can't fit at all, then shift it left as far as it overhangs.
 */
function fitDropdownWithinSidebar(dropdown: HTMLElement): void {
  // Measure from the stylesheet's own placement every time.
  dropdown.style.left = '';
  dropdown.style.maxWidth = '';
  const bounds = clippingBounds(dropdown);
  const available = bounds.right - bounds.left - 2 * DROPDOWN_EDGE_MARGIN;
  if (dropdown.getBoundingClientRect().width > available) {
    dropdown.style.maxWidth = `${Math.max(0, available)}px`;
  }
  const rect = dropdown.getBoundingClientRect();
  const overhang = rect.right - (bounds.right - DROPDOWN_EDGE_MARGIN);
  const room = rect.left - (bounds.left + DROPDOWN_EDGE_MARGIN);
  const shift = Math.min(overhang, room);
  if (shift > 0) dropdown.style.left = `${dropdown.offsetLeft - shift}px`;
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
  refreshKey,
  className,
}: WorkspacePickerProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceDescriptor[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [newWorkspaceError, setNewWorkspaceError] = useState<string | null>(null);
  const [newWorkspacePending, setNewWorkspacePending] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  // Fit before paint, whenever the dropdown's contents can change its width.
  useLayoutEffect(() => {
    if (isOpen && dropdownRef.current) fitDropdownWithinSidebar(dropdownRef.current);
  }, [isOpen, creatingNew, newWorkspaceError, workspaces]);

  // Runs after the fit above. `preventScroll`, because `autoFocus` let the
  // browser scroll the clipping sidebar to reveal the field.
  useLayoutEffect(() => {
    if (creatingNew) createInputRef.current?.focus({ preventScroll: true });
  }, [creatingNew]);

  const closeDropdown = useCallback((returnFocus: boolean) => {
    setIsOpen(false);
    setCreatingNew(false);
    setNewWorkspaceError(null);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  // Close from either pointer or keyboard, with Escape always restoring the
  // trigger even when a pointer-open left focus elsewhere in the dropdown.
  useEffect(() => {
    if (!isOpen) return;
    function handleOutsideClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        closeDropdown(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      closeDropdown(true);
    }
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeDropdown, isOpen]);

  // Host-owned roots are only openable where the host owns roots.
  const electron = hostSupports('nativeWorkspaces');

  const refresh = useCallback(async () => {
    const list = await listWorkspaces();
    // Hide persisted workspaces from the other delivery surface, but retain
    // session-only documents so loose files and DBKs have a visible current
    // workspace and can be revisited until they are moved or closed.
    const filtered = electron
      ? list.filter((w) => w.type === 'host-native' || w.type === 'transient')
      : list.filter((w) => w.type !== 'host-native');
    setWorkspaces(filtered);
  }, [electron]);

  useEffect(() => {
    refresh();
  }, [refresh, activeWorkspaceId, refreshKey]);

  const handleSelect = useCallback(
    async (ws: WorkspaceDescriptor) => {
      await touchWorkspace(ws.id);
      onSelect(ws);
      setIsOpen(false);
    },
    [onSelect],
  );

  const handleStartCreateNew = useCallback(() => {
    const existingNames = new Set(workspaces.map((workspace) => workspace.name.toLowerCase()));
    let suffix = workspaces.length + 1;
    while (existingNames.has(`workspace ${suffix}`.toLowerCase())) suffix += 1;
    setNewWorkspaceName(`Workspace ${suffix}`);
    setNewWorkspaceError(null);
    setCreatingNew(true);
  }, [workspaces]);

  const handleCancelCreateNew = useCallback(() => {
    setCreatingNew(false);
    setNewWorkspaceName('');
    setNewWorkspaceError(null);
  }, []);

  const handleCreateNew = useCallback(async () => {
    if (newWorkspacePending) return;
    const name = newWorkspaceName.trim();
    if (!name) {
      setNewWorkspaceError('Enter a workspace name.');
      return;
    }
    if (name.length > 80) {
      setNewWorkspaceError('Workspace names must be 80 characters or fewer.');
      return;
    }
    if (workspaces.some((workspace) => workspace.name.toLowerCase() === name.toLowerCase())) {
      setNewWorkspaceError('A workspace with that name already exists.');
      return;
    }

    const id = `ws-${Date.now()}`;
    const descriptor: WorkspaceDescriptor = {
      id,
      name,
      type: 'indexeddb',
      lastOpened: new Date().toISOString(),
    };
    setNewWorkspacePending(true);
    setNewWorkspaceError(null);
    try {
      await saveWorkspace(descriptor);
      await refresh();
      onSelect(descriptor);
      setCreatingNew(false);
      setNewWorkspaceName('');
      setIsOpen(false);
    } catch {
      setNewWorkspaceError('The workspace could not be created. Try again.');
    } finally {
      setNewWorkspacePending(false);
    }
  }, [newWorkspaceName, newWorkspacePending, onSelect, refresh, workspaces]);

  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId);
  const activeWorkspaceName = activeWs?.name ?? 'No workspace';

  return (
    <div ref={pickerRef} className={`db-workspace-picker ${className ?? ''}`}>
      <button
        ref={triggerRef}
        className="db-workspace-picker-btn"
        onClick={() => {
          const nextOpen = !isOpen;
          setIsOpen(nextOpen);
          if (!nextOpen) handleCancelCreateNew();
        }}
        title="Switch workspace"
        aria-label={`Switch workspace, current: ${activeWorkspaceName}`}
        aria-expanded={isOpen}
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
        <div ref={dropdownRef} className="db-workspace-dropdown">
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
                  {(ws.type === 'native' || ws.type === 'host-native') && (
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

          {!electron &&
            (creatingNew ? (
              <form
                className="db-workspace-create"
                aria-busy={newWorkspacePending}
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleCreateNew();
                }}
              >
                <label className="db-workspace-create-label" htmlFor="db-new-workspace-name">
                  Workspace name
                </label>
                <input
                  ref={createInputRef}
                  id="db-new-workspace-name"
                  className="db-workspace-create-input"
                  value={newWorkspaceName}
                  maxLength={80}
                  disabled={newWorkspacePending}
                  aria-invalid={newWorkspaceError !== null}
                  aria-describedby={newWorkspaceError ? 'db-new-workspace-error' : undefined}
                  onChange={(event) => {
                    setNewWorkspaceName(event.target.value);
                    setNewWorkspaceError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') handleCancelCreateNew();
                  }}
                />
                {newWorkspaceError && (
                  <p id="db-new-workspace-error" className="db-workspace-create-error" role="alert">
                    {newWorkspaceError}
                  </p>
                )}
                <div className="db-workspace-create-actions">
                  <button
                    type="button"
                    className="db-workspace-create-cancel"
                    disabled={newWorkspacePending}
                    onClick={handleCancelCreateNew}
                  >
                    Cancel
                  </button>
                  <button type="submit" disabled={newWorkspacePending}>
                    {newWorkspacePending ? 'Creating…' : 'Create'}
                  </button>
                </div>
              </form>
            ) : (
              <button className="db-workspace-dropdown-item" onClick={handleStartCreateNew}>
                <span className="db-workspace-dropdown-action-label">
                  <NewFolderIcon />
                  <span>New Workspace</span>
                </span>
              </button>
            ))}

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
