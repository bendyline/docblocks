/**
 * WorkspaceSettingsButton — gear icon dropdown for workspace actions.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { WorkspaceIcon } from '../icons.js';
import { useMenuKeyboard } from '../components/useMenuKeyboard.js';

export interface WorkspaceSettingsButtonProps {
  onSettings: () => void;
  onRename: () => void;
  onDownload: () => void;
  onRemove: () => void;
}

export function WorkspaceSettingsButton({
  onSettings,
  onRename,
  onDownload,
  onRemove,
}: WorkspaceSettingsButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { menuRef, triggerRef, handleMenuKeyDown, handleTriggerKeyDown, closeMenu } =
    useMenuKeyboard(isOpen, setIsOpen);

  useEffect(() => {
    if (!isOpen) return;
    function handleOutsideClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closeMenu(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [closeMenu, isOpen]);

  const handleAction = useCallback(
    (action: () => void) => {
      closeMenu(false);
      action();
    },
    [closeMenu],
  );

  return (
    <div ref={containerRef} className="db-ws-settings">
      <button
        ref={triggerRef}
        className="db-ws-settings-btn"
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleTriggerKeyDown}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label="Workspace settings"
        title="Workspace settings"
      >
        <WorkspaceIcon />
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          className="db-ws-settings-dropdown"
          role="menu"
          onKeyDown={handleMenuKeyDown}
        >
          <button
            className="db-ws-settings-item"
            role="menuitem"
            tabIndex={-1}
            onClick={() => handleAction(onSettings)}
          >
            Workspace settings…
          </button>
          <button
            className="db-ws-settings-item"
            role="menuitem"
            tabIndex={-1}
            onClick={() => handleAction(onRename)}
          >
            Rename workspace
          </button>
          <button
            className="db-ws-settings-item"
            role="menuitem"
            tabIndex={-1}
            onClick={() => handleAction(onDownload)}
          >
            Download workspace
          </button>
          <div className="db-ws-settings-divider" />
          <button
            className="db-ws-settings-item db-ws-settings-item--danger"
            role="menuitem"
            tabIndex={-1}
            onClick={() => handleAction(onRemove)}
          >
            Remove workspace
          </button>
        </div>
      )}
    </div>
  );
}
