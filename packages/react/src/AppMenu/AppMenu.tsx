/**
 * AppMenu — top-left dropdown with workspace actions and app links.
 */

import { useState, useCallback, useRef, useEffect } from 'react';

export interface AppMenuProps {
  /** Called when "Remove this workspace" is selected. */
  onRemoveWorkspace: () => void;
  /** Called when "Rename this workspace" is selected. */
  onRenameWorkspace: () => void;
  /** Called when "Download this workspace" is selected. */
  onDownloadWorkspace: () => void;
  /** URL for the about page. */
  aboutUrl?: string;
}

export function AppMenu({
  onRemoveWorkspace,
  onRenameWorkspace,
  onDownloadWorkspace,
  aboutUrl = '#about',
}: AppMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    function handleOutsideClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
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
    <div ref={menuRef} className="db-app-menu">
      <button
        className="db-app-menu-btn"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <span className="db-app-menu-label">docblocks</span>
        <span className="db-app-menu-caret">{isOpen ? '\u25B4' : '\u25BE'}</span>
      </button>

      {isOpen && (
        <div className="db-app-menu-dropdown" role="menu">
          <button
            className="db-app-menu-item"
            role="menuitem"
            onClick={() => handleAction(onRenameWorkspace)}
          >
            Rename this workspace
          </button>
          <button
            className="db-app-menu-item"
            role="menuitem"
            onClick={() => handleAction(onDownloadWorkspace)}
          >
            Download this workspace
          </button>
          <div className="db-app-menu-divider" />
          <button
            className="db-app-menu-item db-app-menu-item--danger"
            role="menuitem"
            onClick={() => handleAction(onRemoveWorkspace)}
          >
            Remove this workspace
          </button>
          <div className="db-app-menu-divider" />
          <a
            className="db-app-menu-item"
            href={aboutUrl}
            role="menuitem"
            onClick={() => setIsOpen(false)}
          >
            About
          </a>
        </div>
      )}
    </div>
  );
}
