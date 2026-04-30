/**
 * AppMenu — top-left dropdown with workspace actions and app links.
 */

import { useState, useCallback, useRef, useEffect } from 'react';

export type ThemePreference = 'auto' | 'light' | 'dark';

export interface AppMenuProps {
  /** URL for the about page. */
  aboutUrl?: string;
  /** Optional logo image URL to display instead of the text label. */
  logoUrl?: string;
  /** Current theme preference. */
  themePreference?: ThemePreference;
  /** Called when the user changes the theme preference. */
  onThemeChange?: (theme: ThemePreference) => void;
  /**
   * Called when the user clicks "Download all workspaces". When omitted,
   * the menu item is hidden.
   */
  onDownloadAllWorkspaces?: () => void | Promise<void>;
}

export function AppMenu({
  aboutUrl: _aboutUrl = '#about',
  logoUrl,
  themePreference = 'auto',
  onThemeChange,
  onDownloadAllWorkspaces,
}: AppMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
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
    <>
      <div ref={menuRef} className="db-app-menu">
        <button
          className="db-app-menu-btn"
          onClick={() => setIsOpen(!isOpen)}
          aria-expanded={isOpen}
          aria-haspopup="true"
        >
          {logoUrl ? (
            <img src={logoUrl} alt="docblocks" className="db-app-menu-logo" />
          ) : (
            <span className="db-app-menu-label">docblocks</span>
          )}
          <span className={`db-app-menu-caret${isOpen ? ' db-app-menu-caret--open' : ''}`}>
            {'\u25BE'}
          </span>
        </button>

        {isOpen && (
          <div className="db-app-menu-dropdown" role="menu">
            <button
              className="db-app-menu-item"
              role="menuitem"
              onClick={() => handleAction(() => setShowSettings(true))}
            >
              Settings
            </button>
            {onDownloadAllWorkspaces && (
              <button
                className="db-app-menu-item"
                role="menuitem"
                onClick={() => handleAction(() => void onDownloadAllWorkspaces())}
              >
                Download all workspaces
              </button>
            )}
            <div className="db-app-menu-divider" />
            <button
              className="db-app-menu-item"
              role="menuitem"
              onClick={() => handleAction(() => setShowAbout(true))}
            >
              About
            </button>
          </div>
        )}
      </div>

      {showSettings && (
        <div className="db-dialog-overlay" onClick={() => setShowSettings(false)}>
          <div
            className="db-dialog"
            role="dialog"
            aria-label="Settings"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="db-dialog-header">
              <h2 className="db-dialog-title">Settings</h2>
              <button
                className="db-dialog-close"
                onClick={() => setShowSettings(false)}
                aria-label="Close"
              >
                &times;
              </button>
            </div>
            <div className="db-dialog-body">
              <fieldset className="db-settings-fieldset">
                <legend className="db-settings-legend">Theme</legend>
                <label className="db-settings-radio">
                  <input
                    type="radio"
                    name="theme"
                    value="auto"
                    checked={themePreference === 'auto'}
                    onChange={() => onThemeChange?.('auto')}
                  />
                  System default
                </label>
                <label className="db-settings-radio">
                  <input
                    type="radio"
                    name="theme"
                    value="light"
                    checked={themePreference === 'light'}
                    onChange={() => onThemeChange?.('light')}
                  />
                  Light
                </label>
                <label className="db-settings-radio">
                  <input
                    type="radio"
                    name="theme"
                    value="dark"
                    checked={themePreference === 'dark'}
                    onChange={() => onThemeChange?.('dark')}
                  />
                  Dark
                </label>
              </fieldset>
            </div>
          </div>
        </div>
      )}

      {showAbout && (
        <div className="db-dialog-overlay" onClick={() => setShowAbout(false)}>
          <div
            className="db-dialog"
            role="dialog"
            aria-label="About DocBlocks"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="db-dialog-header">
              <h2 className="db-dialog-title">About DocBlocks</h2>
              <button
                className="db-dialog-close"
                onClick={() => setShowAbout(false)}
                aria-label="Close"
              >
                &times;
              </button>
            </div>
            <div className="db-dialog-body">
              <p>
                <strong>DocBlocks</strong> is a markdown document editor that runs entirely in your
                browser. Your files stay on your device.
              </p>
              <p>
                Built on{' '}
                <a
                  href="https://github.com/bendyline/squisq"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  squisq
                </a>{' '}
                by Bendyline.
              </p>
              <p className="db-dialog-links">
                <a
                  href="https://github.com/bendyline/docblocks"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  GitHub
                </a>
                <span className="db-dialog-sep">&middot;</span>
                <a
                  href="https://github.com/bendyline/docblocks/blob/main/LICENSE"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  License (MIT)
                </a>
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
