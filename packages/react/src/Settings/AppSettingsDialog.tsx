/**
 * The app Settings dialog, in sections: Appearance, AI, Dictation, Narration
 * and Device integration. A section appears only when the host offers what it
 * configures, so the browser build shows fewer than the desktop app.
 */

import { useEffect, useState } from 'react';
import {
  getHostEnvironment,
  type DocBlocksHostAiAPI,
  type DocBlocksHostMenuAPI,
  type DocBlocksHostSpeechAPI,
} from '@bendyline/docblocks/host';
import type { VersioningPreference } from '../preferences/versioning.js';
import type {
  AccentColor,
  InterfaceFontPreference,
  ThemePreference,
} from '../preferences/theme.js';
import type { WriteCanvasPreferences } from '../preferences/write-canvas.js';
import type { ProofingPreferences } from '../preferences/proofing.js';
import {
  AccentColorSettings,
  InterfaceFontSettings,
  ProofingSettingsControls,
  SettingsDialog,
  ThemeSettings,
  WriteCanvasSettingsControls,
  type SettingsSection,
} from './Settings.js';
import { AiSettingsControls } from './AiSettings.js';
import { DictationSettingsControls, NarrationSettingsControls } from './SpeechSettings.js';
import { TraySettingsControls } from './TraySettings.js';
import { useSpeechSettings } from './useSpeechSettings.js';

export type AppSettingsSection = 'appearance' | 'ai' | 'dictation' | 'narration' | 'device';

export interface AppSettingsDialogProps {
  onClose: () => void;
  /** The open section; one the host does not offer falls back to Appearance. */
  section: AppSettingsSection;
  onSectionChange: (section: AppSettingsSection) => void;
  themePreference: ThemePreference;
  onThemeChange?: (theme: ThemePreference) => void;
  accentColor: AccentColor;
  onAccentColorChange?: (color: AccentColor) => void;
  interfaceFont: InterfaceFontPreference;
  onInterfaceFontChange?: (font: InterfaceFontPreference) => void;
  writeCanvasSettings: WriteCanvasPreferences;
  onWriteCanvasSettingsChange?: (settings: WriteCanvasPreferences) => void;
  proofingPreferences: ProofingPreferences;
  onProofingPreferencesChange?: (settings: ProofingPreferences) => void;
  ai?: DocBlocksHostAiAPI;
  speech?: DocBlocksHostSpeechAPI;
  tray?: DocBlocksHostMenuAPI;
  /** Origin storage usage/quota, fetched each time the dialog opens; omitted hides Storage. */
  getStorageEstimate?: () => Promise<{ usage: number; quota: number } | null>;
  storagePersistent?: boolean;
  /** Asks the browser to keep origin storage. The caller closes Settings first. */
  onKeepBrowserData?: () => void;
  requestingPersistentStorage?: boolean;
  versioningPreference: VersioningPreference;
  onVersioningPreferenceChange?: (pref: VersioningPreference) => void;
  /** Opens the active workspace's own settings. The caller closes Settings first. */
  onOpenWorkspaceSettings?: () => void;
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

export function AppSettingsDialog({
  onClose,
  section,
  onSectionChange,
  themePreference,
  onThemeChange,
  accentColor,
  onAccentColorChange,
  interfaceFont,
  onInterfaceFontChange,
  writeCanvasSettings,
  onWriteCanvasSettingsChange,
  proofingPreferences,
  onProofingPreferencesChange,
  ai,
  speech,
  tray,
  getStorageEstimate,
  storagePersistent,
  onKeepBrowserData,
  requestingPersistentStorage = false,
  versioningPreference,
  onVersioningPreferenceChange,
  onOpenWorkspaceSettings,
}: AppSettingsDialogProps) {
  // One session for both speech sections, alive as long as the dialog is.
  const speechSession = useSpeechSettings(speech);
  const [storageEstimate, setStorageEstimate] = useState<{
    usage: number;
    quota: number;
  } | null>(null);

  // Refresh the Storage figures each time the dialog opens.
  useEffect(() => {
    if (!getStorageEstimate) return;
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
  }, [getStorageEstimate]);

  const sections: SettingsSection<AppSettingsSection>[] = [
    {
      id: 'appearance',
      label: 'Appearance',
      content: (
        <>
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
        </>
      ),
    },
  ];

  if (ai) {
    sections.push({ id: 'ai', label: 'AI', content: <AiSettingsControls ai={ai} /> });
  }
  if (speechSession?.speech.transcribe) {
    sections.push({
      id: 'dictation',
      label: 'Dictation',
      content: <DictationSettingsControls session={speechSession} />,
    });
  }
  if (speechSession?.speech.synthesize) {
    sections.push({
      id: 'narration',
      label: 'Narration',
      content: <NarrationSettingsControls session={speechSession} />,
    });
  }

  if (tray || getStorageEstimate || onVersioningPreferenceChange) {
    sections.push({
      id: 'device',
      label: 'Device integration',
      content: (
        <>
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
                  onClick={onKeepBrowserData}
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
                  onClick={onOpenWorkspaceSettings}
                >
                  This workspace&rsquo;s settings&hellip;
                </button>
              )}
            </fieldset>
          )}
        </>
      ),
    });
  }

  return (
    <SettingsDialog
      onClose={onClose}
      sections={sections}
      section={section}
      onSectionChange={onSectionChange}
    />
  );
}
