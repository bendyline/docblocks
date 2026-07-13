/**
 * AppMenu — top-left dropdown with workspace actions and app links.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { VersioningPreference } from '../preferences/versioning.js';
import { ACCENT_COLORS, type AccentColor, type ThemePreference } from '../preferences/theme.js';

export type { AccentColor, ThemePreference } from '../preferences/theme.js';

const ACCENT_LABELS: Record<AccentColor, string> = {
  brown: 'Brown',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
  maroon: 'Maroon',
  orange: 'Orange',
  gray: 'Gray',
};

export interface AppMenuProps {
  /** URL for the about page. */
  aboutUrl?: string;
  /** Optional logo image URL to display instead of the text label. */
  logoUrl?: string;
  /** Current theme preference. */
  themePreference?: ThemePreference;
  /** Called when the user changes the theme preference. */
  onThemeChange?: (theme: ThemePreference) => void;
  /** Current accent color. */
  accentColor?: AccentColor;
  /** Called when the user changes the accent color. */
  onAccentColorChange?: (color: AccentColor) => void;
  /** Current global versioning preference. */
  versioningPreference?: VersioningPreference;
  /** Called when the user changes the global versioning preference. */
  onVersioningPreferenceChange?: (pref: VersioningPreference) => void;
  /**
   * Called when the user clicks "Download all workspaces". When omitted,
   * the menu item is hidden.
   */
  onDownloadAllWorkspaces?: () => void | Promise<void>;
  /**
   * Called when the user asks the browser to keep origin storage persistent.
   * When omitted, the menu item is hidden.
   */
  onKeepBrowserData?: () => void | Promise<void>;
  /**
   * Called when the user clicks "Install DocBlocks…" (browser PWA install).
   * When omitted — Electron, unsupported browsers, or already installed —
   * the menu item is hidden.
   */
  onInstallApp?: () => void | Promise<void>;
  /**
   * Async origin storage usage/quota for the Settings "Storage" section
   * (fetched when the dialog opens). When omitted — Electron, or browsers
   * without `navigator.storage.estimate` — the section is hidden.
   */
  getStorageEstimate?: () => Promise<{ usage: number; quota: number } | null>;
  /** Whether the browser has marked origin storage persistent (Settings display). */
  storagePersistent?: boolean;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 'B';
  for (const next of ['KB', 'MB', 'GB', 'TB']) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 || unit === 'B' ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

export function AppMenu({
  aboutUrl: _aboutUrl = '#about',
  logoUrl,
  themePreference = 'auto',
  onThemeChange,
  accentColor = 'brown',
  onAccentColorChange,
  versioningPreference = 'browser-only',
  onVersioningPreferenceChange,
  onDownloadAllWorkspaces,
  onKeepBrowserData,
  onInstallApp,
  getStorageEstimate,
  storagePersistent,
}: AppMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [storageEstimate, setStorageEstimate] = useState<{
    usage: number;
    quota: number;
  } | null>(null);

  // Refresh the Settings "Storage" figures each time the dialog opens.
  useEffect(() => {
    if (!showSettings || !getStorageEstimate) return;
    let cancelled = false;
    getStorageEstimate()
      .then((estimate) => {
        if (!cancelled) setStorageEstimate(estimate);
      })
      .catch(() => {
        if (!cancelled) setStorageEstimate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [showSettings, getStorageEstimate]);

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
          <span
            className={`db-app-menu-caret${isOpen ? ' db-app-menu-caret--open' : ''}`}
            aria-hidden="true"
          />
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
            {onInstallApp && (
              <button
                className="db-app-menu-item"
                role="menuitem"
                onClick={() => handleAction(() => void onInstallApp())}
              >
                Install DocBlocks&hellip;
              </button>
            )}
            {onKeepBrowserData && (
              <button
                className="db-app-menu-item"
                role="menuitem"
                onClick={() => handleAction(() => void onKeepBrowserData())}
              >
                Keep data in browser for longer
              </button>
            )}
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

              <fieldset className="db-settings-fieldset">
                <legend className="db-settings-legend">Accent color</legend>
                <p className="db-settings-hint">Used in both light and dark appearances.</p>
                <div className="db-settings-accent-grid">
                  {ACCENT_COLORS.map((color) => (
                    <label
                      className={`db-settings-accent${
                        accentColor === color ? ' db-settings-accent--selected' : ''
                      }`}
                      key={color}
                    >
                      <input
                        className="db-settings-accent-input"
                        type="radio"
                        name="accent-color"
                        value={color}
                        checked={accentColor === color}
                        onChange={() => onAccentColorChange?.(color)}
                      />
                      <span
                        className={`db-settings-accent-swatch db-settings-accent-swatch--${color}`}
                        aria-hidden="true"
                      />
                      <span>{ACCENT_LABELS[color]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              {getStorageEstimate && (
                <fieldset className="db-settings-fieldset">
                  <legend className="db-settings-legend">Storage</legend>
                  <p className="db-settings-hint">
                    {storageEstimate
                      ? `DocBlocks documents and app data are using ${formatBytes(
                          storageEstimate.usage,
                        )} of the ${formatBytes(
                          storageEstimate.quota,
                        )} this browser allows for the site.`
                      : 'Storage usage is not available in this browser.'}{' '}
                    {storagePersistent === undefined
                      ? ''
                      : storagePersistent
                        ? 'Data is marked persistent, so the browser will avoid evicting it.'
                        : 'Data is not yet marked persistent — use “Keep data in browser for longer” in the app menu.'}
                  </p>
                </fieldset>
              )}

              {onVersioningPreferenceChange && (
                <fieldset className="db-settings-fieldset">
                  <legend className="db-settings-legend">Version history</legend>
                  <p className="db-settings-hint">
                    When on, DocBlocks keeps prior revisions of each document inside a sibling{' '}
                    <code>&lt;name&gt;_files/.versions/</code> folder. Individual workspaces can
                    override this default in their own settings.
                  </p>
                  <label className="db-settings-radio">
                    <input
                      type="radio"
                      name="versioning"
                      value="on"
                      checked={versioningPreference === 'on'}
                      onChange={() => onVersioningPreferenceChange('on')}
                    />
                    On for all workspaces
                  </label>
                  <label className="db-settings-radio">
                    <input
                      type="radio"
                      name="versioning"
                      value="browser-only"
                      checked={versioningPreference === 'browser-only'}
                      onChange={() => onVersioningPreferenceChange('browser-only')}
                    />
                    On in browser workspaces, off for local folders
                  </label>
                  <label className="db-settings-radio">
                    <input
                      type="radio"
                      name="versioning"
                      value="off"
                      checked={versioningPreference === 'off'}
                      onChange={() => onVersioningPreferenceChange('off')}
                    />
                    Off for all workspaces
                  </label>
                </fieldset>
              )}
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
                by{' '}
                <a href="https://bendyline.com" target="_blank" rel="noopener noreferrer">
                  Bendyline
                </a>
                .
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
                <span className="db-dialog-sep">&middot;</span>
                <a
                  href="https://github.com/bendyline/docblocks/blob/main/NOTICE.md"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  &hearts; built on open source
                </a>
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
