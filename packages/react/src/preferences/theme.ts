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

const THEME_STORAGE_KEY = 'docblocks:themePreference';
const ACCENT_STORAGE_KEY = 'docblocks:accentColor';

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
