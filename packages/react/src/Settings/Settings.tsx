/** Shared controls used by the app and host-specific DocBlocks settings dialogs. */

import type { ReactNode } from 'react';
import { Dialog } from '../components/Dialog.js';
import { ACCENT_COLORS, type AccentColor, type ThemePreference } from '../preferences/theme.js';
import {
  WRITE_CANVAS_LINE_SPACING_MAX,
  WRITE_CANVAS_LINE_SPACING_MIN,
  WRITE_CANVAS_TEXT_SIZE_MAX,
  WRITE_CANVAS_TEXT_SIZE_MIN,
  type WriteCanvasPreferences,
} from '../preferences/write-canvas.js';

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

export interface WriteCanvasSettingsControlsProps {
  value: WriteCanvasPreferences;
  onChange: (settings: WriteCanvasPreferences) => void;
}

export function WriteCanvasSettingsControls({ value, onChange }: WriteCanvasSettingsControlsProps) {
  return (
    <fieldset className="db-settings-fieldset">
      <legend className="db-settings-legend">Write canvas</legend>
      <p className="db-settings-hint">
        Adjust the writing view without changing the document or its exported text.
      </p>
      <label className="db-settings-slider">
        <span className="db-settings-slider-header">
          <span>Text size</span>
          <output className="db-settings-slider-value" aria-hidden="true">
            {value.textSize}px
          </output>
        </span>
        <input
          type="range"
          min={WRITE_CANVAS_TEXT_SIZE_MIN}
          max={WRITE_CANVAS_TEXT_SIZE_MAX}
          step={1}
          value={value.textSize}
          aria-label="Text size"
          aria-valuetext={`${value.textSize} pixels`}
          onChange={(event) => onChange({ ...value, textSize: Number(event.currentTarget.value) })}
        />
      </label>
      <label className="db-settings-slider">
        <span className="db-settings-slider-header">
          <span>Line spacing</span>
          <output className="db-settings-slider-value" aria-hidden="true">
            {formatLineSpacing(value.lineSpacing)}
          </output>
        </span>
        <input
          type="range"
          min={WRITE_CANVAS_LINE_SPACING_MIN}
          max={WRITE_CANVAS_LINE_SPACING_MAX}
          step={0.1}
          value={value.lineSpacing}
          aria-label="Line spacing"
          aria-valuetext={`${value.lineSpacing} times`}
          onChange={(event) =>
            onChange({ ...value, lineSpacing: Number(event.currentTarget.value) })
          }
        />
      </label>
    </fieldset>
  );
}

function formatLineSpacing(value: number): string {
  return `${value.toFixed(1).replace(/\.0$/, '')}\u00d7`;
}
