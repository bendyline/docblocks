/**
 * WorkspaceSettingsButton — gear icon dropdown for workspace actions.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { WorkspaceIcon } from '../icons.js';

export interface WorkspaceSettingsButtonProps {
  onRename: () => void;
  onDownload: () => void;
  onRemove: () => void;
}

export function WorkspaceSettingsButton({
  onRename,
  onDownload,
  onRemove,
}: WorkspaceSettingsButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    function handleOutsideClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [isOpen]);

  const handleAction = useCallback((action: () => void) => {
    setIsOpen(false);
    action();
  }, []);

  return (
    <div ref={ref} className="db-ws-settings">
      <button
        className="db-ws-settings-btn"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="true"
        aria-label="Workspace settings"
        title="Workspace settings"
      >
        <WorkspaceIcon />
      </button>

      {isOpen && (
        <div className="db-ws-settings-dropdown" role="menu">
          <button
            className="db-ws-settings-item"
            role="menuitem"
            onClick={() => handleAction(onRename)}
          >
            Rename workspace
          </button>
          <button
            className="db-ws-settings-item"
            role="menuitem"
            onClick={() => handleAction(onDownload)}
          >
            Download workspace
          </button>
          <div className="db-ws-settings-divider" />
          <button
            className="db-ws-settings-item db-ws-settings-item--danger"
            role="menuitem"
            onClick={() => handleAction(onRemove)}
          >
            Remove workspace
          </button>
        </div>
      )}
    </div>
  );
}
