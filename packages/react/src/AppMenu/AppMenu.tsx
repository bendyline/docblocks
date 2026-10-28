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
import { AppSettingsDialog, type AppSettingsSection } from '../Settings/AppSettingsDialog.js';
import { Dialog } from '../components/Dialog.js';
import { useMenuKeyboard } from '../components/useMenuKeyboard.js';
import { displayBuildDate } from '../local-date.js';

export type { AccentColor, ThemePreference } from '../preferences/theme.js';
export type { AppSettingsSection } from '../Settings/AppSettingsDialog.js';

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
   * Async origin storage usage/quota for the Settings "Storage" group
   * (fetched when the dialog opens). When omitted — Electron, or browsers
   * without `navigator.storage.estimate` — the group is hidden.
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
   * The host's speech API. When present, Settings offers Dictation and
   * Narration sections for the engines it has; when omitted both are hidden.
   */
  speech?: DocBlocksHostSpeechAPI;
  /**
   * The host's menu API, when it offers the opt-in tray / menu bar icon
   * (`hostSupports('trayIcon')`). When omitted the setting is hidden.
   */
  tray?: DocBlocksHostMenuAPI;
  /** Opens Settings whenever it changes to a new non-zero value. */
  settingsRequest?: number;
  /** The section `settingsRequest` opens on; otherwise the last one shown. */
  settingsRequestSection?: AppSettingsSection;
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
  settingsRequestSection,
}: AppMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // The section Settings last showed, so reopening it returns there.
  const [settingsSection, setSettingsSection] = useState<AppSettingsSection>('appearance');
  useEffect(() => {
    if (settingsRequest <= 0) return;
    if (settingsRequestSection) setSettingsSection(settingsRequestSection);
    setShowSettings(true);
  }, [settingsRequest, settingsRequestSection]);
  const [requestingPersistentStorage, setRequestingPersistentStorage] = useState(false);
  // Genuinely an identity question, not a capability one: each surface has its
  // own product page. Kept as an exhaustive record so a new surface has to
  // choose a page rather than silently inheriting the web one.
  const surface = getHostEnvironment()?.surface ?? 'web';
  const moreInformationUrl = MORE_INFORMATION_URLS[surface] ?? MORE_INFORMATION_URLS.web;
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
        <AppSettingsDialog
          onClose={() => setShowSettings(false)}
          section={settingsSection}
          onSectionChange={setSettingsSection}
          themePreference={themePreference}
          onThemeChange={onThemeChange}
          accentColor={accentColor}
          onAccentColorChange={onAccentColorChange}
          interfaceFont={interfaceFont}
          onInterfaceFontChange={onInterfaceFontChange}
          writeCanvasSettings={writeCanvasSettings}
          onWriteCanvasSettingsChange={onWriteCanvasSettingsChange}
          proofingPreferences={proofingPreferences}
          onProofingPreferencesChange={onProofingPreferencesChange}
          ai={ai}
          speech={speech}
          tray={tray}
          getStorageEstimate={getStorageEstimate}
          storagePersistent={storagePersistent}
          onKeepBrowserData={
            onKeepBrowserData ? () => void handleKeepBrowserDataFromSettings() : undefined
          }
          requestingPersistentStorage={requestingPersistentStorage}
          versioningPreference={versioningPreference}
          onVersioningPreferenceChange={onVersioningPreferenceChange}
          onOpenWorkspaceSettings={
            onOpenWorkspaceSettings
              ? () => {
                  setShowSettings(false);
                  onOpenWorkspaceSettings();
                }
              : undefined
          }
        />
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
