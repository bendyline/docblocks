/** Appearance preferences shared by the shell and settings UI. */

export type ThemePreference = 'auto' | 'light' | 'dark';

export const ACCENT_COLORS = [
  'brown',
  'green',
  'blue',
  'purple',
  'maroon',
  'orange',
  'gray',
] as const;

export type AccentColor = (typeof ACCENT_COLORS)[number];

/**
 * Chrome (titlebar) background per resolved theme. Keep in sync with
 * `--db-bg-subtle` for the default accent in styles/docblocks.css and with
 * the static `<meta name="theme-color">` values in the site's index.html.
 * The shell writes these into the theme-color metas so the installed web
 * app's titlebar (Window Controls Overlay caption area, Android status bar)
 * follows the resolved theme.
 */
export const DB_CHROME_COLORS: Record<'light' | 'dark', string> = {
  light: '#f3eede',
  dark: '#262219',
};

/**
 * Which typeface the shell chrome uses.
 *
 * `system` resolves `system-ui`, so DocBlocks looks native on each platform —
 * the right default, and what almost everyone should keep. `fixed` pins the
 * chrome to the bundled `DocBlocks Fixed UI` face (the Roboto variable binary
 * already shipped for the document theme of that name) so the interface renders
 * identically everywhere.
 *
 * Two things want that. A user working across machines gets typography that
 * does not shift between them. And the visual-regression suite gets a rendering
 * it can compare across operating systems at all: under `system` the same
 * screenshot differs on every platform, which is why those baselines are
 * otherwise captured on one OS and compared only there.
 */
export type InterfaceFontPreference = 'system' | 'fixed';

export const DEFAULT_INTERFACE_FONT: InterfaceFontPreference = 'system';

const THEME_STORAGE_KEY = 'docblocks:themePreference';
const ACCENT_STORAGE_KEY = 'docblocks:accentColor';
const INTERFACE_FONT_STORAGE_KEY = 'docblocks:interfaceFont';

export function loadThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw;
  } catch {
    // ignore unavailable storage
  }
  return 'auto';
}

export function saveThemePreference(value: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, value);
  } catch {
    // ignore quota errors
  }
}

export function loadAccentColor(): AccentColor {
  try {
    const raw = localStorage.getItem(ACCENT_STORAGE_KEY);
    if (ACCENT_COLORS.some((color) => color === raw)) return raw as AccentColor;
  } catch {
    // ignore unavailable storage
  }
  return 'brown';
}

export function saveAccentColor(value: AccentColor): void {
  try {
    localStorage.setItem(ACCENT_STORAGE_KEY, value);
  } catch {
    // ignore quota errors
  }
}

export function loadInterfaceFont(): InterfaceFontPreference {
  try {
    const raw = localStorage.getItem(INTERFACE_FONT_STORAGE_KEY);
    if (raw === 'system' || raw === 'fixed') return raw;
  } catch {
    // ignore unavailable storage
  }
  return DEFAULT_INTERFACE_FONT;
}

export function saveInterfaceFont(value: InterfaceFontPreference): void {
  try {
    localStorage.setItem(INTERFACE_FONT_STORAGE_KEY, value);
  } catch {
    // ignore quota errors
  }
}
