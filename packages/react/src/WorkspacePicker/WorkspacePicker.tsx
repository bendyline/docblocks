/**
 * WorkspacePicker — dropdown for switching between workspaces
 * (IndexedDB-based or native folder via File System Access API).
 */

import { Fragment, useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceDescriptor } from '@bendyline/docblocks/workspace';
import { listWorkspaces, saveWorkspace, touchWorkspace } from '@bendyline/docblocks/workspace';
import { hostSupports } from '@bendyline/docblocks/host';
import { FolderIcon, MoreIcon, NewFolderIcon } from '../icons.js';

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
  /**
   * Called when the user chooses "Remove workspace" from a row's actions menu
   * (its ⋯ button, a right-click, or Shift+F10). The host confirms and does
   * the removal. Omitted, rows have no actions menu.
   */
  onRemoveWorkspace?: (descriptor: WorkspaceDescriptor) => void;
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

/**
 * A row's actions menu. It is portaled out of the sidebar, which clips, so it
 * is placed in viewport coordinates: under the ⋯ button with its right edges
 * aligned, or at the pointer for a right-click.
 */
interface WorkspaceMenuState {
  workspace: WorkspaceDescriptor;
  x: number;
  y: number;
  alignRight: boolean;
  /** Opened from the keyboard, so focus moves into the menu. */
  keyboard: boolean;
}

/** Only these removals destroy documents rather than forget a folder or file. */
function removalDestroysDocuments(workspace: WorkspaceDescriptor): boolean {
  return workspace.type === 'indexeddb' || (workspace.type === 'transient' && !workspace.origin);
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
  onRemoveWorkspace,
  refreshKey,
  className,
}: WorkspacePickerProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceDescriptor[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [newWorkspaceError, setNewWorkspaceError] = useState<string | null>(null);
  const [newWorkspacePending, setNewWorkspacePending] = useState(false);
  const [workspaceMenu, setWorkspaceMenu] = useState<WorkspaceMenuState | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const workspaceMenuReturnFocusRef = useRef<HTMLElement | null>(null);
  const workspaceMenuOpen = workspaceMenu !== null;

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
    setWorkspaceMenu(null);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const openWorkspaceMenu = useCallback((menu: WorkspaceMenuState, returnFocusTo: HTMLElement) => {
    workspaceMenuReturnFocusRef.current = returnFocusTo;
    setWorkspaceMenu(menu);
  }, []);

  const closeWorkspaceMenu = useCallback((returnFocus: boolean) => {
    setWorkspaceMenu(null);
    if (returnFocus) workspaceMenuReturnFocusRef.current?.focus({ preventScroll: true });
  }, []);

  // Close from either pointer or keyboard, with Escape always restoring the
  // trigger even when a pointer-open left focus elsewhere in the dropdown.
  // Escape closes an open row menu first and leaves the dropdown up.
  useEffect(() => {
    if (!isOpen) return;
    function handleOutsideClick(e: MouseEvent) {
      const target = e.target as Node;
      // The row menu is portaled, so it is outside the picker in the DOM.
      if (workspaceMenuRef.current?.contains(target)) return;
      if (pickerRef.current && !pickerRef.current.contains(target)) {
        closeDropdown(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      if (workspaceMenuOpen) closeWorkspaceMenu(true);
      else closeDropdown(true);
    }
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeDropdown, closeWorkspaceMenu, isOpen, workspaceMenuOpen]);

  // A click or right-click anywhere outside the row menu dismisses it; a
  // right-click on another row then reopens it there. Scrolling would leave
  // the fixed-position menu behind its row, so that dismisses it too.
  useEffect(() => {
    if (!workspaceMenuOpen) return;
    function handleOutsideAction(event: Event) {
      if (!workspaceMenuRef.current?.contains(event.target as Node)) setWorkspaceMenu(null);
    }
    function handleScroll() {
      setWorkspaceMenu(null);
    }
    document.addEventListener('click', handleOutsideAction, true);
    document.addEventListener('contextmenu', handleOutsideAction, true);
    document.addEventListener('scroll', handleScroll, { capture: true, once: true });
    return () => {
      document.removeEventListener('click', handleOutsideAction, true);
      document.removeEventListener('contextmenu', handleOutsideAction, true);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [workspaceMenuOpen]);

  // Place the row menu before paint, kept inside the viewport.
  useLayoutEffect(() => {
    const menu = workspaceMenuRef.current;
    if (!workspaceMenu || !menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const left = workspaceMenu.alignRight ? workspaceMenu.x - width : workspaceMenu.x;
    menu.style.left = `${Math.max(4, Math.min(left, window.innerWidth - width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(workspaceMenu.y, window.innerHeight - height - 4))}px`;
    if (workspaceMenu.keyboard) {
      menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    }
  }, [workspaceMenu]);

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
          {workspaces.map((ws) => {
            const active = ws.id === activeWorkspaceId;
            const menuOpen = workspaceMenu?.workspace.id === ws.id;
            return (
              <div
                key={ws.id}
                className={`db-workspace-dropdown-row${active ? ' db-workspace-dropdown-row--active' : ''}`}
              >
                <button
                  className={`db-workspace-dropdown-item ${
                    active ? 'db-workspace-dropdown-item--active' : ''
                  }`}
                  aria-keyshortcuts={onRemoveWorkspace ? 'Shift+F10' : undefined}
                  onClick={() => handleSelect(ws)}
                  onContextMenu={(event) => {
                    if (!onRemoveWorkspace) return;
                    event.preventDefault();
                    openWorkspaceMenu(
                      {
                        workspace: ws,
                        x: event.clientX,
                        y: event.clientY,
                        alignRight: false,
                        keyboard: false,
                      },
                      event.currentTarget,
                    );
                  }}
                  onKeyDown={(event) => {
                    if (!onRemoveWorkspace) return;
                    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) {
                      return;
                    }
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    openWorkspaceMenu(
                      {
                        workspace: ws,
                        x: rect.left + 16,
                        y: rect.bottom,
                        alignRight: false,
                        keyboard: true,
                      },
                      event.currentTarget,
                    );
                  }}
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
                {onRemoveWorkspace && (
                  <button
                    type="button"
                    className="db-workspace-dropdown-more"
                    aria-label={`More actions for ${ws.name}`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    title="More actions"
                    onClick={(event) => {
                      if (menuOpen) {
                        closeWorkspaceMenu(false);
                        return;
                      }
                      const rect = event.currentTarget.getBoundingClientRect();
                      openWorkspaceMenu(
                        {
                          workspace: ws,
                          x: rect.right,
                          y: rect.bottom,
                          alignRight: true,
                          // Enter or Space reports no pointer clicks.
                          keyboard: event.detail === 0,
                        },
                        event.currentTarget,
                      );
                    }}
                  >
                    <MoreIcon />
                  </button>
                )}
              </div>
            );
          })}

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

      {isOpen &&
        workspaceMenu &&
        onRemoveWorkspace &&
        createPortal(
          <div
            ref={workspaceMenuRef}
            className="db-tree-context db-workspace-menu"
            role="menu"
            aria-label={`Actions for ${workspaceMenu.workspace.name}`}
            onKeyDown={(event) => {
              if (event.key === 'Escape' || event.key === 'Tab') {
                event.preventDefault();
                event.stopPropagation();
                closeWorkspaceMenu(true);
              }
            }}
          >
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={`db-tree-context-item${
                removalDestroysDocuments(workspaceMenu.workspace)
                  ? ' db-tree-context-item--danger'
                  : ''
              }`}
              onClick={() => {
                const { workspace } = workspaceMenu;
                // Hand focus back to the picker so the confirmation dialog
                // restores it there; the row menu and dropdown are going away.
                closeDropdown(true);
                onRemoveWorkspace(workspace);
              }}
            >
              Remove workspace…
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
