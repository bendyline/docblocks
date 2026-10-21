/**
 * AppMenu — top-left dropdown with workspace actions and app links.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  getHostEnvironment,
  type DocBlocksHostAiAPI,
  type DocBlocksHostMenuAPI,
  type DocBlocksHostSpeechAPI,
  type HostSurfaceKind,
} from '@bendyline/docblocks/host';
import type { VersioningPreference } from '../preferences/versioning.js';
import type {
  AccentColor,
  InterfaceFontPreference,
  ThemePreference,
} from '../preferences/theme.js';
import {
  DEFAULT_WRITE_CANVAS_PREFERENCES,
  type WriteCanvasPreferences,
} from '../preferences/write-canvas.js';
import { DEFAULT_PROOFING_PREFERENCES, type ProofingPreferences } from '../preferences/proofing.js';
import {
  AccentColorSettings,
  InterfaceFontSettings,
  ProofingSettingsControls,
  SettingsDialog,
  ThemeSettings,
  WriteCanvasSettingsControls,
} from '../Settings/Settings.js';
import { AiSettingsControls } from '../Settings/AiSettings.js';
import { SpeechSettingsControls } from '../Settings/SpeechSettings.js';
import { TraySettingsControls } from '../Settings/TraySettings.js';
import { Dialog } from '../components/Dialog.js';
import { useMenuKeyboard } from '../components/useMenuKeyboard.js';
import { displayBuildDate } from '../local-date.js';

export type { AccentColor, ThemePreference } from '../preferences/theme.js';

export interface AppMenuProps {
  /** Optional logo image URL to display instead of the text label. */
  logoUrl?: string;
  /**
   * The logo drawn for dark appearances. Without it, the light logo is
   * inverted in dark mode, which suits only a flat black-on-transparent mark.
   */
  logoDarkUrl?: string;
  /** Current theme preference. */
  themePreference?: ThemePreference;
  /** Called when the user changes the theme preference. */
  onThemeChange?: (theme: ThemePreference) => void;
  /** Current accent color. */
  accentColor?: AccentColor;
  /** Chrome typeface: follow the OS, or use the bundled face. */
  interfaceFont?: InterfaceFontPreference;
  /** Called when the user changes the accent color. */
  onAccentColorChange?: (color: AccentColor) => void;
  onInterfaceFontChange?: (font: InterfaceFontPreference) => void;
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
  /** Opens the active workspace's own settings (`.docblocks/workspace.json`). */
  onOpenWorkspaceSettings?: () => void;
  /**
   * Called when the user clicks "Back up all workspaces". When omitted,
   * the menu item is hidden.
   */
  onDownloadAllWorkspaces?: () => void | Promise<void>;
  /** Restore a ZIP backup into new browser workspaces. */
  onRestoreBackup?: () => void;
  /** Opens the keyboard-shortcut sheet. When omitted, the menu item is hidden. */
  onShowKeyboardShortcuts?: () => void;
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
  /**
   * Build date shown in About: an ISO timestamp, shown as the viewer's local
   * day, or a bare `YYYY-MM-DD`, shown as given.
   */
  appBuildDate?: string;
  /**
   * The host's AI API. When present, Settings offers an AI section; when
   * omitted — a host without AI — the section is hidden.
   */
  ai?: DocBlocksHostAiAPI;
  /**
   * The host's speech API. When present, Settings offers a Speech section for
   * dictation and narration models; when omitted the section is hidden.
   */
  speech?: DocBlocksHostSpeechAPI;
  /**
   * The host's menu API, when it offers the opt-in tray / menu bar icon
   * (`hostSupports('trayIcon')`). When omitted the section is hidden.
   */
  tray?: DocBlocksHostMenuAPI;
  /** Opens Settings whenever it changes to a new non-zero value. */
  settingsRequest?: number;
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

/** The same guide the sidebar footer's Docs link opens. */
const DOCUMENTATION_URL = 'https://docblocks.com/docs/';

const MORE_INFORMATION_URLS: Readonly<Record<HostSurfaceKind | 'web', string>> = Object.freeze({
  electron: 'https://docblocks.com/desktop/',
  capacitor: 'https://docblocks.com/web/',
  web: 'https://docblocks.com/web/',
});

export function AppMenu({
  logoUrl,
  logoDarkUrl,
  themePreference = 'auto',
  onThemeChange,
  accentColor = 'rust',
  onAccentColorChange,
  interfaceFont = 'system',
  onInterfaceFontChange,
  writeCanvasSettings = DEFAULT_WRITE_CANVAS_PREFERENCES,
  onWriteCanvasSettingsChange,
  proofingPreferences = DEFAULT_PROOFING_PREFERENCES,
  onProofingPreferencesChange,
  versioningPreference = 'browser-only',
  onVersioningPreferenceChange,
  onOpenWorkspaceSettings,
  onDownloadAllWorkspaces,
  onRestoreBackup,
  onShowKeyboardShortcuts,
  onKeepBrowserData,
  onInstallApp,
  getStorageEstimate,
  storagePersistent,
  appVersion,
  appBuildDate,
  ai,
  speech,
  tray,
  settingsRequest = 0,
}: AppMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  useEffect(() => {
    if (settingsRequest > 0) setShowSettings(true);
  }, [settingsRequest]);
  const [requestingPersistentStorage, setRequestingPersistentStorage] = useState(false);
  // Genuinely an identity question, not a capability one: each surface has its
  // own product page. Kept as an exhaustive record so a new surface has to
  // choose a page rather than silently inheriting the web one.
  const surface = getHostEnvironment()?.surface ?? 'web';
  const moreInformationUrl = MORE_INFORMATION_URLS[surface] ?? MORE_INFORMATION_URLS.web;
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
      // The menu item unmounts before a dialog can capture its return target.
      closeMenu(true);
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
            <>
              <img
                src={logoUrl}
                alt="DocBlocks"
                className={`db-app-menu-logo ${logoDarkUrl ? 'db-app-menu-logo--light' : 'db-app-menu-logo--invert'}`}
                width={557}
                height={242}
              />
              {logoDarkUrl && (
                <img
                  src={logoDarkUrl}
                  alt="DocBlocks"
                  className="db-app-menu-logo db-app-menu-logo--dark"
                  width={557}
                  height={242}
                />
              )}
            </>
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
            {/* Keeping work safe is one group: the backup the footer and the
                storage-full banner also offer, by the same name, then the
                request that the browser keep its copy. */}
            {(onDownloadAllWorkspaces || onRestoreBackup || onKeepBrowserData) && (
              <div className="db-app-menu-divider" />
            )}
            {onDownloadAllWorkspaces && (
              <button
                className="db-app-menu-item"
                role="menuitem"
                tabIndex={-1}
                onClick={() => handleAction(() => void onDownloadAllWorkspaces())}
              >
                Back up all workspaces
              </button>
            )}
            {onRestoreBackup && (
              <button
                className="db-app-menu-item"
                role="menuitem"
                tabIndex={-1}
                onClick={() => handleAction(onRestoreBackup)}
              >
                Restore backup…
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
            <div className="db-app-menu-divider" />
            {onShowKeyboardShortcuts && (
              <button
                className="db-app-menu-item db-app-menu-item--with-shortcut"
                role="menuitem"
                tabIndex={-1}
                aria-keyshortcuts="F1"
                onClick={() => handleAction(onShowKeyboardShortcuts)}
              >
                Keyboard shortcuts
                <span className="db-app-menu-shortcut" aria-hidden="true">
                  F1
                </span>
              </button>
            )}
            <a
              className="db-app-menu-item"
              role="menuitem"
              tabIndex={-1}
              href={DOCUMENTATION_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => closeMenu(false)}
            >
              Documentation
            </a>
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
          <InterfaceFontSettings
            value={interfaceFont}
            onChange={(font) => onInterfaceFontChange?.(font)}
          />
          <WriteCanvasSettingsControls
            value={writeCanvasSettings}
            onChange={(settings) => onWriteCanvasSettingsChange?.(settings)}
          />
          <ProofingSettingsControls
            value={proofingPreferences}
            onChange={(settings) => onProofingPreferencesChange?.(settings)}
          />
          {ai && <AiSettingsControls ai={ai} />}
          {speech && <SpeechSettingsControls speech={speech} />}
          {tray && <TraySettingsControls menu={tray} platform={getHostEnvironment()?.platform} />}

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
              {onOpenWorkspaceSettings && (
                <button
                  type="button"
                  className="db-git-secondary-btn db-settings-link-btn"
                  onClick={() => {
                    setShowSettings(false);
                    onOpenWorkspaceSettings();
                  }}
                >
                  This workspace&rsquo;s settings&hellip;
                </button>
              )}
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
          {appVersion && (
            <p className="db-about-version">
              <span>Version</span>
              <code aria-label={`DocBlocks version ${appVersion}`}>{appVersion}</code>
            </p>
          )}
          {appBuildDate && (
            <p className="db-about-version">
              <span>Build</span>
              <time dateTime={appBuildDate}>{displayBuildDate(appBuildDate)}</time>
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
          {/* Only the browser build points at the desktop apps; desktop and
              mobile users are already running a native app. */}
          {surface === 'web' && (
            <p>
              See our free desktop apps at{' '}
              <a href={MORE_INFORMATION_URLS.electron} target="_blank" rel="noopener noreferrer">
                docblocks.com/desktop
              </a>
              .
            </p>
          )}
          <p className="db-dialog-links">
            <a href={moreInformationUrl} target="_blank" rel="noopener noreferrer">
              More information...
            </a>
            <a
              href="https://github.com/bendyline/docblocks"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
            <a
              href="https://github.com/bendyline/docblocks/releases"
              target="_blank"
              rel="noopener noreferrer"
            >
              Release notes
            </a>
            <a
              href="https://github.com/bendyline/docblocks/issues"
              target="_blank"
              rel="noopener noreferrer"
            >
              Support
            </a>
            <a
              href="https://github.com/bendyline/docblocks/blob/main/LICENSE"
              target="_blank"
              rel="noopener noreferrer"
            >
              License (MIT)
            </a>
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
