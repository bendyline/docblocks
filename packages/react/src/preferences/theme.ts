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
 * `fixed` — the default — pins the chrome to the bundled `DocBlocks Fixed UI`
 * face: the Hanken Grotesk variable binary every surface already ships for
 * documents set in it, and the sans docblocks.com uses. The app and the site
 * then read as one product, and the interface renders identically on every
 * OS — which is also what lets the visual-regression suite compare one set of
 * baselines across platforms at all.
 *
 * `system` resolves `system-ui`, for anyone who would rather DocBlocks looked
 * native on each platform; the chrome then fetches no font.
 *
 * The stored values kept their names when the default changed, so a saved
 * `system` still opts out. A saved `fixed` now gets Hanken Grotesk; it used to
 * get Roboto.
 */
export type InterfaceFontPreference = 'system' | 'fixed';

export const DEFAULT_INTERFACE_FONT: InterfaceFontPreference = 'fixed';

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
