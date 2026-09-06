/** Shared controls used by the app and host-specific DocBlocks settings dialogs. */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Dialog } from '../components/Dialog.js';
import { ACCENT_COLORS, type AccentColor, type ThemePreference } from '../preferences/theme.js';
import type { ProofingPreferences } from '../preferences/proofing.js';
import {
  WRITE_CANVAS_FONT_SCHEMES,
  WRITE_CANVAS_LINE_SPACING_MAX,
  WRITE_CANVAS_LINE_SPACING_MIN,
  WRITE_CANVAS_TEXT_SIZE_MAX,
  WRITE_CANVAS_TEXT_SIZE_MIN,
  type WriteCanvasFontScheme,
  type WriteCanvasFontSchemeGroup,
  type WriteCanvasFontSchemeOption,
  type WriteCanvasPreferences,
} from '../preferences/write-canvas.js';

export type { AccentColor, ThemePreference } from '../preferences/theme.js';
export type { ProofingPreferences } from '../preferences/proofing.js';

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
    <Dialog title={title} onClose={onClose} size="wide">
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
      <div className="db-settings-radio-row">
        <label className="db-settings-radio db-settings-radio--inline">
          <input
            type="radio"
            name={name}
            value="auto"
            checked={value === 'auto'}
            onChange={() => onChange('auto')}
          />
          System default
        </label>
        <label className="db-settings-radio db-settings-radio--inline">
          <input
            type="radio"
            name={name}
            value="light"
            checked={value === 'light'}
            onChange={() => onChange('light')}
          />
          Light
        </label>
        <label className="db-settings-radio db-settings-radio--inline">
          <input
            type="radio"
            name={name}
            value="dark"
            checked={value === 'dark'}
            onChange={() => onChange('dark')}
          />
          Dark
        </label>
      </div>
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

export interface ProofingSettingsControlsProps {
  value: ProofingPreferences;
  onChange: (settings: ProofingPreferences) => void;
}

/**
 * Spelling and grammar squiggles, as two switches. Grammar is separable
 * because harper's grammar rules are English-only — a writer working in
 * another language wants the spell checker and none of the green
 * underlines. With both off no checking engine is ever downloaded.
 */
export function ProofingSettingsControls({ value, onChange }: ProofingSettingsControlsProps) {
  return (
    <fieldset className="db-settings-fieldset">
      <legend className="db-settings-legend">Spelling and grammar</legend>
      <p className="db-settings-hint">
        Checking runs on this device — nothing you write is sent anywhere.
      </p>
      <label className="db-settings-checkbox">
        <input
          type="checkbox"
          checked={value.spelling}
          onChange={(event) => onChange({ ...value, spelling: event.currentTarget.checked })}
        />
        Show inline spell checking
      </label>
      <label className="db-settings-checkbox">
        <input
          type="checkbox"
          checked={value.grammar}
          onChange={(event) => onChange({ ...value, grammar: event.currentTarget.checked })}
        />
        Show inline grammar checking
      </label>
      <p className="db-settings-hint">(Grammar checking is currently only available for English)</p>
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
      <FontSchemePicker
        value={value.fontScheme}
        onChange={(fontScheme) => onChange({ ...value, fontScheme })}
      />
    </fieldset>
  );
}

interface FontSchemePickerProps {
  value: WriteCanvasFontScheme;
  onChange: (scheme: WriteCanvasFontScheme) => void;
}

interface FontPickerPosition {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
}

/**
 * A listbox rather than a native select so every choice can preview both
 * halves of its font pairing. Native option rendering does not reliably honor
 * font-family, and cannot use separate families within one option.
 */
function FontSchemePicker({ value, onChange }: FontSchemePickerProps) {
  const selectedIndex = Math.max(
    0,
    WRITE_CANVAS_FONT_SCHEMES.findIndex((scheme) => scheme.id === value),
  );
  const selectedScheme = WRITE_CANVAS_FONT_SCHEMES[selectedIndex];
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [menuPosition, setMenuPosition] = useState<FontPickerPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const labelId = useId();
  const listboxId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setIsOpen(false);
    setMenuPosition(null);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const gutter = 8;
    const gap = 4;
    const width = Math.min(rect.width, viewportWidth - gutter * 2);
    const left = Math.min(Math.max(gutter, rect.left), viewportWidth - width - gutter);
    const spaceBelow = viewportHeight - rect.bottom - gap - gutter;
    const spaceAbove = rect.top - gap - gutter;
    const openAbove = spaceBelow < 260 && spaceAbove > spaceBelow;
    const availableHeight = openAbove ? spaceAbove : spaceBelow;
    const maxHeight = Math.max(80, Math.min(420, availableHeight));

    setMenuPosition(
      openAbove
        ? {
            left,
            bottom: viewportHeight - rect.top + gap,
            width,
            maxHeight,
          }
        : {
            left,
            top: rect.bottom + gap,
            width,
            maxHeight,
          },
    );
  }, []);

  const open = useCallback(
    (index: number) => {
      setActiveIndex(index);
      updateMenuPosition();
      setIsOpen(true);
    },
    [updateMenuPosition],
  );

  useEffect(() => {
    if (!isOpen) setActiveIndex(selectedIndex);
  }, [isOpen, selectedIndex]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updateMenuPosition();
    listboxRef.current?.focus({ preventScroll: true });
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, isOpen, updateMenuPosition]);

  useEffect(() => {
    if (!isOpen) return;

    const handleOutsidePointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    const handleViewportChange = () => updateMenuPosition();

    document.addEventListener('mousedown', handleOutsidePointer);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', handleOutsidePointer);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [close, isOpen, updateMenuPosition]);

  const select = useCallback(
    (index: number) => {
      const scheme = WRITE_CANVAS_FONT_SCHEMES[index];
      if (!scheme) return;
      onChange(scheme.id);
      close(true);
    },
    [close, onChange],
  );

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open(selectedIndex);
    }
  };

  const handleListboxKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((current) => (current + 1) % WRITE_CANVAS_FONT_SCHEMES.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex(
          (current) =>
            (current - 1 + WRITE_CANVAS_FONT_SCHEMES.length) % WRITE_CANVAS_FONT_SCHEMES.length,
        );
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(WRITE_CANVAS_FONT_SCHEMES.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        select(activeIndex);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
    }
  };

  const menuStyle = menuPosition
    ? {
        left: `${menuPosition.left}px`,
        top: menuPosition.top === undefined ? undefined : `${menuPosition.top}px`,
        bottom: menuPosition.bottom === undefined ? undefined : `${menuPosition.bottom}px`,
        width: `${menuPosition.width}px`,
        maxHeight: `${menuPosition.maxHeight}px`,
      }
    : undefined;

  return (
    <div ref={rootRef} className="db-settings-select db-font-picker">
      <span className="db-settings-select-header">
        <span id={labelId}>Font</span>
      </span>
      <button
        ref={triggerRef}
        type="button"
        className="db-font-picker-trigger"
        aria-label={`Font, ${selectedScheme.label}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        onClick={() => (isOpen ? close(false) : open(selectedIndex))}
        onKeyDown={handleTriggerKeyDown}
      >
        <FontSchemePreview scheme={selectedScheme} compact />
        <span
          className={`db-font-picker-caret${isOpen ? ' db-font-picker-caret--open' : ''}`}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <div
          ref={listboxRef}
          id={listboxId}
          className="db-font-picker-menu"
          style={menuStyle}
          role="listbox"
          tabIndex={-1}
          aria-labelledby={labelId}
          aria-activedescendant={`${listboxId}-option-${activeIndex}`}
          onKeyDown={handleListboxKeyDown}
        >
          {WRITE_CANVAS_FONT_SCHEMES.filter((scheme) => scheme.group === 'theme').map((scheme) =>
            renderFontSchemeOption(scheme),
          )}
          {FONT_SCHEME_GROUPS.map(({ group, label }) => (
            <div key={group} role="group" aria-label={label}>
              <div className="db-font-picker-group" aria-hidden="true">
                {label}
              </div>
              {WRITE_CANVAS_FONT_SCHEMES.filter((scheme) => scheme.group === group).map((scheme) =>
                renderFontSchemeOption(scheme),
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  function renderFontSchemeOption(scheme: WriteCanvasFontSchemeOption) {
    const index = WRITE_CANVAS_FONT_SCHEMES.indexOf(scheme);
    const selected = scheme.id === value;
    const active = index === activeIndex;
    return (
      <div
        ref={(element) => {
          optionRefs.current[index] = element;
        }}
        id={`${listboxId}-option-${index}`}
        key={scheme.id}
        className={`db-font-picker-option${selected ? ' db-font-picker-option--selected' : ''}${
          active ? ' db-font-picker-option--active' : ''
        }`}
        role="option"
        aria-selected={selected}
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => setActiveIndex(index)}
        onClick={() => select(index)}
      >
        <FontSchemePreview scheme={scheme} />
        <span className="db-font-picker-check" aria-hidden="true">
          {selected ? '\u2713' : ''}
        </span>
      </div>
    );
  }
}

function FontSchemePreview({
  scheme,
  compact = false,
}: {
  scheme: WriteCanvasFontSchemeOption;
  compact?: boolean;
}) {
  const labels = scheme.label.split(/\s*\u00b7\s*/u);
  const headingLabel = labels[0] ?? scheme.label;
  const bodyLabel =
    labels[1] ?? (scheme.id === 'theme' ? 'Use the active theme' : 'Headings & body');

  return (
    <span className={`db-font-picker-preview${compact ? ' db-font-picker-preview--compact' : ''}`}>
      <span
        className="db-font-picker-heading"
        style={scheme.headerFont ? { fontFamily: scheme.headerFont } : undefined}
      >
        {headingLabel}
      </span>
      <span
        className="db-font-picker-body"
        style={scheme.bodyFont ? { fontFamily: scheme.bodyFont } : undefined}
      >
        {bodyLabel}
      </span>
    </span>
  );
}

const FONT_SCHEME_GROUPS: ReadonlyArray<{
  group: Exclude<WriteCanvasFontSchemeGroup, 'theme'>;
  label: string;
}> = [
  { group: 'system', label: 'System fonts' },
  { group: 'curated', label: 'Curated pairings' },
];

function formatLineSpacing(value: number): string {
  return `${value.toFixed(1).replace(/\.0$/, '')}\u00d7`;
}
