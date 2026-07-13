/** Shared controls used by the app and host-specific DocBlocks settings dialogs. */

import type { ReactNode } from 'react';
import { Dialog } from '../components/Dialog.js';
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

export interface SettingsDialogProps {
  title?: string;
  onClose: () => void;
  children: ReactNode;
}

export function SettingsDialog({ title = 'Settings', onClose, children }: SettingsDialogProps) {
  return (
    <Dialog title={title} onClose={onClose}>
      {children}
    </Dialog>
  );
}

export interface ThemeSettingsProps {
  value: ThemePreference;
  onChange: (theme: ThemePreference) => void;
  name?: string;
}

export function ThemeSettings({ value, onChange, name = 'theme' }: ThemeSettingsProps) {
  return (
    <fieldset className="db-settings-fieldset">
      <legend className="db-settings-legend">Theme</legend>
      <label className="db-settings-radio">
        <input
          type="radio"
          name={name}
          value="auto"
          checked={value === 'auto'}
          onChange={() => onChange('auto')}
        />
        System default
      </label>
      <label className="db-settings-radio">
        <input
          type="radio"
          name={name}
          value="light"
          checked={value === 'light'}
          onChange={() => onChange('light')}
        />
        Light
      </label>
      <label className="db-settings-radio">
        <input
          type="radio"
          name={name}
          value="dark"
          checked={value === 'dark'}
          onChange={() => onChange('dark')}
        />
        Dark
      </label>
    </fieldset>
  );
}

export interface AccentColorSettingsProps {
  value: AccentColor;
  onChange: (color: AccentColor) => void;
  name?: string;
}

export function AccentColorSettings({
  value,
  onChange,
  name = 'accent-color',
}: AccentColorSettingsProps) {
  return (
    <fieldset className="db-settings-fieldset">
      <legend className="db-settings-legend">Accent color</legend>
      <p className="db-settings-hint">Used in both light and dark appearances.</p>
      <div className="db-settings-accent-grid">
        {ACCENT_COLORS.map((color) => (
          <label
            className={`db-settings-accent${
              value === color ? ' db-settings-accent--selected' : ''
            }`}
            key={color}
          >
            <input
              className="db-settings-accent-input"
              type="radio"
              name={name}
              value={color}
              checked={value === color}
              onChange={() => onChange(color)}
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
  );
}
