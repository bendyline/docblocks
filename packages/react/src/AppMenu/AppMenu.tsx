/**
 * AppMenu — top-left dropdown with workspace actions and app links.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { isElectronHost } from '@bendyline/docblocks/host';
import type { VersioningPreference } from '../preferences/versioning.js';
import type { AccentColor, ThemePreference } from '../preferences/theme.js';
import {
  DEFAULT_WRITE_CANVAS_PREFERENCES,
  type WriteCanvasPreferences,
} from '../preferences/write-canvas.js';
import { DEFAULT_PROOFING_PREFERENCES, type ProofingPreferences } from '../preferences/proofing.js';
import {
  AccentColorSettings,
  ProofingSettingsControls,
  SettingsDialog,
  ThemeSettings,
  WriteCanvasSettingsControls,
} from '../Settings/Settings.js';
import { Dialog } from '../components/Dialog.js';
import { useMenuKeyboard } from '../components/useMenuKeyboard.js';

export type { AccentColor, ThemePreference } from '../preferences/theme.js';

export interface AppMenuProps {
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
  /** Current typography preferences for the editor's Write canvas. */
  writeCanvasSettings?: WriteCanvasPreferences;
  /** Called when the user changes the Write canvas typography. */
  onWriteCanvasSettingsChange?: (settings: WriteCanvasPreferences) => void;
  /** Current inline spelling/grammar checking preferences. */
  proofingPreferences?: ProofingPreferences;
  /** Called when the user toggles inline spelling or grammar checking. */
  onProofingPreferencesChange?: (settings: ProofingPreferences) => void;
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
  /** Human-readable version/build and delivery surface shown in About. */
  appVersion?: string;
  /** ISO build date shown in About. */
  appBuildDate?: string;
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
  logoUrl,
  themePreference = 'auto',
  onThemeChange,
  accentColor = 'brown',
  onAccentColorChange,
  writeCanvasSettings = DEFAULT_WRITE_CANVAS_PREFERENCES,
  onWriteCanvasSettingsChange,
  proofingPreferences = DEFAULT_PROOFING_PREFERENCES,
  onProofingPreferencesChange,
  versioningPreference = 'browser-only',
  onVersioningPreferenceChange,
  onDownloadAllWorkspaces,
  onKeepBrowserData,
  onInstallApp,
  getStorageEstimate,
  storagePersistent,
  appVersion,
  appBuildDate,
}: AppMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [requestingPersistentStorage, setRequestingPersistentStorage] = useState(false);
  const moreInformationUrl = isElectronHost()
    ? 'https://docblocks.com/desktop/'
    : 'https://docblocks.com/web/';
  const containerRef = useRef<HTMLDivElement>(null);
  const { menuRef, triggerRef, handleMenuKeyDown, handleTriggerKeyDown, closeMenu } =
    useMenuKeyboard(isOpen, setIsOpen);
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

  const handleKeepBrowserDataFromSettings = useCallback(async () => {
    if (!onKeepBrowserData || requestingPersistentStorage) return;
    // The request reports durable-storage outcomes through the shell's shared
    // acknowledgement dialog. Close Settings before starting it so two modal
    // dialogs (and their focus traps) can never overlap. Both overlays use the
    // same modal layer, which otherwise leaves the outcome hidden underneath
    // the later-rendered Settings dialog.
    setShowSettings(false);
    setRequestingPersistentStorage(true);
    try {
      await onKeepBrowserData();
    } finally {
      setRequestingPersistentStorage(false);
    }
  }, [onKeepBrowserData, requestingPersistentStorage]);

  return (
    <>
      <div ref={containerRef} className="db-app-menu">
        <button
          ref={triggerRef}
          className="db-app-menu-btn"
          onClick={() => setIsOpen(!isOpen)}
          onKeyDown={handleTriggerKeyDown}
          aria-expanded={isOpen}
          aria-haspopup="menu"
        >
          {logoUrl ? (
            <img
              src={logoUrl}
              alt="DocBlocks"
              className="db-app-menu-logo"
              width={1266}
              height={544}
            />
          ) : (
            <span className="db-app-menu-label">docblocks</span>
          )}
          <span
            className={`db-app-menu-caret${isOpen ? ' db-app-menu-caret--open' : ''}`}
            aria-hidden="true"
          />
        </button>

        {isOpen && (
          <div
            ref={menuRef}
            className="db-app-menu-dropdown"
            role="menu"
            onKeyDown={handleMenuKeyDown}
          >
            <button
              className="db-app-menu-item"
              role="menuitem"
              tabIndex={-1}
              onClick={() => handleAction(() => setShowSettings(true))}
            >
              Settings
            </button>
            {onInstallApp && (
              <button
                className="db-app-menu-item"
                role="menuitem"
                tabIndex={-1}
                onClick={() => handleAction(() => void onInstallApp())}
              >
                Install DocBlocks&hellip;
              </button>
            )}
            {onKeepBrowserData && (
              <button
                className="db-app-menu-item"
                role="menuitem"
                tabIndex={-1}
                onClick={() => handleAction(() => void handleKeepBrowserDataFromSettings())}
              >
                Protect data from browser cleanup
              </button>
            )}
            {onDownloadAllWorkspaces && (
              <button
                className="db-app-menu-item"
                role="menuitem"
                tabIndex={-1}
                onClick={() => handleAction(() => void onDownloadAllWorkspaces())}
              >
                Download all workspaces
              </button>
            )}
            <div className="db-app-menu-divider" />
            <button
              className="db-app-menu-item"
              role="menuitem"
              tabIndex={-1}
              onClick={() => handleAction(() => setShowAbout(true))}
            >
              About
            </button>
          </div>
        )}
      </div>

      {showSettings && (
        <SettingsDialog onClose={() => setShowSettings(false)}>
          <ThemeSettings
            value={themePreference}
            onChange={(preference) => onThemeChange?.(preference)}
          />
          <AccentColorSettings
            value={accentColor}
            onChange={(color) => onAccentColorChange?.(color)}
          />
          <WriteCanvasSettingsControls
            value={writeCanvasSettings}
            onChange={(settings) => onWriteCanvasSettingsChange?.(settings)}
          />
          <ProofingSettingsControls
            value={proofingPreferences}
            onChange={(settings) => onProofingPreferencesChange?.(settings)}
          />

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
                  : 'Storage usage is not available in this browser.'}
              </p>
              {storagePersistent !== undefined && (
                <p className="db-settings-hint">
                  {storagePersistent
                    ? 'Protected from routine browser cleanup on this device.'
                    : 'Browsers may clear site data under storage pressure unless protection is granted.'}
                </p>
              )}
              {onKeepBrowserData && (
                <button
                  type="button"
                  className="db-settings-action"
                  disabled={requestingPersistentStorage}
                  onClick={() => void handleKeepBrowserDataFromSettings()}
                >
                  {requestingPersistentStorage
                    ? 'Requesting storage protection…'
                    : 'Protect data from browser cleanup'}
                </button>
              )}
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
        </SettingsDialog>
      )}

      {showAbout && (
        <Dialog title="About DocBlocks" onClose={() => setShowAbout(false)}>
          <p>
            <strong>DocBlocks</strong> is a local-first Markdown document editor. Your files stay
            under your control.
          </p>
          <aside className="db-about-beta">
            <strong>Beta Software.</strong> We&apos;re still working through initial hiccups and
            issues. Please bear with us, make sure you keep backups, and{' '}
            <a
              href="https://github.com/bendyline/docblocks/issues/new"
              target="_blank"
              rel="noopener noreferrer"
            >
              open issues
            </a>{' '}
            where you find them. Thanks!
          </aside>
          {appVersion && (
            <p className="db-about-version">
              <span>Version</span>
              <code aria-label={`DocBlocks version ${appVersion}`}>{appVersion}</code>
            </p>
          )}
          {appBuildDate && (
            <p className="db-about-version">
              <span>Build</span>
              <time dateTime={appBuildDate}>{appBuildDate}</time>
            </p>
          )}
          <p>
            Built with{' '}
            <a href="https://github.com/bendyline/squisq" target="_blank" rel="noopener noreferrer">
              squisq
            </a>{' '}
            by{' '}
            <a href="https://bendyline.com" target="_blank" rel="noopener noreferrer">
              Bendyline
            </a>
            .
          </p>
          <p className="db-dialog-links">
            <a href={moreInformationUrl} target="_blank" rel="noopener noreferrer">
              More information...
            </a>
            <span className="db-dialog-sep">&middot;</span>
            <a
              href="https://github.com/bendyline/docblocks"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
            <span className="db-dialog-sep">&middot;</span>
            <a
              href="https://github.com/bendyline/docblocks/releases"
              target="_blank"
              rel="noopener noreferrer"
            >
              Release notes
            </a>
            <span className="db-dialog-sep">&middot;</span>
            <a
              href="https://github.com/bendyline/docblocks/issues"
              target="_blank"
              rel="noopener noreferrer"
            >
              Support
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
        </Dialog>
      )}
    </>
  );
}
