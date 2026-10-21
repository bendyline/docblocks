/**
 * The tray section of the app Settings dialog: one switch for the opt-in icon
 * in the macOS menu bar, the Windows notification area, or the Linux system
 * tray. The host persists the choice and shows or removes the icon at once.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocBlocksHostMenuAPI, HostPlatform } from '@bendyline/docblocks/host';

export interface TraySettingsControlsProps {
  /** The host's menu API; Settings shows this only when `hostSupports('trayIcon')`. */
  menu: DocBlocksHostMenuAPI;
  platform?: HostPlatform;
}

/** What each desktop calls the place the icon lives. */
function trayPlace(platform: HostPlatform | undefined): { legend: string; label: string } {
  switch (platform) {
    case 'darwin':
      return { legend: 'Menu bar', label: 'Show DocBlocks in the menu bar' };
    case 'win32':
      return {
        legend: 'Notification area',
        label: 'Show DocBlocks in the notification area',
      };
    default:
      return { legend: 'System tray', label: 'Show DocBlocks in the system tray' };
  }
}

export function TraySettingsControls({ menu, platform }: TraySettingsControlsProps) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const read = menu.getTrayEnabled;
    if (read) {
      read.call(menu).then(
        (value) => {
          if (mounted.current) setEnabled(value);
        },
        () => {
          if (mounted.current) setFailure('DocBlocks could not read this setting.');
        },
      );
    }
    return () => {
      mounted.current = false;
    };
  }, [menu]);

  const change = useCallback(
    async (next: boolean) => {
      const write = menu.setTrayEnabled;
      if (!write) return;
      setSaving(true);
      setFailure(null);
      setEnabled(next);
      try {
        const saved = await write.call(menu, next);
        if (mounted.current) setEnabled(saved);
      } catch {
        if (mounted.current) {
          setEnabled(!next);
          setFailure('DocBlocks could not change this setting. Try again.');
        }
      } finally {
        if (mounted.current) setSaving(false);
      }
    },
    [menu],
  );

  const place = trayPlace(platform);
  return (
    <fieldset className="db-settings-fieldset">
      <legend className="db-settings-legend">{place.legend}</legend>
      <label className="db-settings-checkbox">
        <input
          type="checkbox"
          checked={enabled === true}
          disabled={enabled === null || saving}
          onChange={(event) => void change(event.currentTarget.checked)}
        />
        {place.label}
      </label>
      <p className="db-settings-hint">
        One click to a new document, a folder, or any document you have pinned.
      </p>
      {failure && (
        <p className="db-settings-hint db-settings-ai-error" role="alert">
          {failure}
        </p>
      )}
    </fieldset>
  );
}
