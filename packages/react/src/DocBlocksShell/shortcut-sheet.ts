/**
 * The keyboard-shortcut sheet's contents.
 *
 * The shell's own keys come from `SHELL_SHORTCUTS`, the table that also binds
 * them, so the sheet cannot advertise a key the shell does not handle. The
 * editing, view and presenting keys belong to Squisq; they are listed here as
 * Squisq binds them (Tiptap's StarterKit plus Squisq's heading, script, view
 * and slideshow keys) and must follow it if it changes them.
 */

import { SHELL_SHORTCUTS } from './keyboard-shortcuts.js';

/** One key of a chord. `Mod` is Ctrl, or ⌘ on Apple platforms. */
export type ShortcutKey = string;

export interface ShortcutSheetEntry {
  action: string;
  /** Alternative chords, any of which performs the action. */
  chords: readonly (readonly ShortcutKey[])[];
}

export interface ShortcutSheetSection {
  title: string;
  entries: readonly ShortcutSheetEntry[];
}

export interface ShortcutSheetOptions {
  /**
   * Whether a native host delivers every chord to the app. In a browser tab
   * the browser keeps some (Ctrl+N), so those are left off the sheet.
   */
  nativeHost: boolean;
}

const VIEW_KEYS: ShortcutSheetSection = {
  title: 'Views',
  entries: [
    { action: 'Write', chords: [['Mod', 'Shift', '1']] },
    { action: 'Source', chords: [['Mod', 'Shift', '2']] },
    { action: 'Use (preview, slideshow, video)', chords: [['Mod', 'Shift', '3']] },
  ],
};

const EDITING_KEYS: ShortcutSheetSection = {
  title: 'Formatting in Write',
  entries: [
    { action: 'Bold', chords: [['Mod', 'B']] },
    { action: 'Italic', chords: [['Mod', 'I']] },
    { action: 'Strikethrough', chords: [['Mod', 'Shift', 'S']] },
    { action: 'Inline code', chords: [['Mod', 'E']] },
    { action: 'Link', chords: [['Mod', 'K']] },
    { action: 'Heading 1–6', chords: [['Mod', 'Alt', '1–6']] },
    { action: 'Bulleted list', chords: [['Mod', 'Shift', '8']] },
    { action: 'Numbered list', chords: [['Mod', 'Shift', '7']] },
    { action: 'Quote', chords: [['Mod', 'Shift', 'B']] },
    { action: 'Superscript', chords: [['Mod', '.']] },
    { action: 'Subscript', chords: [['Mod', ',']] },
    { action: 'Line break', chords: [['Shift', 'Enter']] },
    { action: 'Undo', chords: [['Mod', 'Z']] },
    { action: 'Redo', chords: [['Mod', 'Shift', 'Z']] },
  ],
};

const PRESENTING_KEYS: ShortcutSheetSection = {
  title: 'Slideshow',
  entries: [
    { action: 'Next slide or step', chords: [['→'], ['Space']] },
    { action: 'Previous slide or step', chords: [['←']] },
    { action: 'First or last slide', chords: [['Home'], ['End']] },
    { action: 'Pick a slide', chords: [['↑']] },
    { action: 'Leave the presentation', chords: [['Esc']] },
  ],
};

/** `Ctrl+Shift+F` as the keys of the chord, with Ctrl as the platform `Mod`. */
function labelKeys(label: string): ShortcutKey[] {
  return label.split('+').map((key) => (key === 'Ctrl' ? 'Mod' : key));
}

/** The shell's listed keys, one entry per action with all of its chords. */
function shellEntries({ nativeHost }: ShortcutSheetOptions): ShortcutSheetEntry[] {
  const entries = new Map<string, { action?: string; chords: ShortcutKey[][] }>();
  for (const binding of SHELL_SHORTCUTS) {
    if (binding.browserReserved && !nativeHost) continue;
    const entry = entries.get(binding.id) ?? { chords: [] };
    entry.action ??= binding.action;
    entry.chords.push(labelKeys(binding.label));
    entries.set(binding.id, entry);
  }
  return [...entries.values()].flatMap((entry) =>
    entry.action ? [{ action: entry.action, chords: entry.chords }] : [],
  );
}

export function shortcutSheet(options: ShortcutSheetOptions): ShortcutSheetSection[] {
  return [
    { title: 'Documents and files', entries: shellEntries(options) },
    VIEW_KEYS,
    EDITING_KEYS,
    PRESENTING_KEYS,
  ];
}

const APPLE_MODIFIERS: Readonly<Record<string, string>> = {
  Mod: '⌘',
  Alt: '⌥',
  Shift: '⇧',
};
/** Apple's conventional modifier order: Option, Shift, Command. */
const APPLE_ORDER = ['Alt', 'Shift', 'Mod'];

/** The keys to draw for a chord on this platform. */
export function displayKeys(chord: readonly ShortcutKey[], apple: boolean): string[] {
  if (!apple) return chord.map((key) => (key === 'Mod' ? 'Ctrl' : key));
  const modifiers = APPLE_ORDER.filter((key) => chord.includes(key));
  const rest = chord.filter((key) => !(key in APPLE_MODIFIERS));
  return [...modifiers.map((key) => APPLE_MODIFIERS[key]!), ...rest];
}

const SPOKEN_KEYS: Readonly<Record<string, string>> = {
  '→': 'Right arrow',
  '←': 'Left arrow',
  '↑': 'Up arrow',
  '?': 'Question mark',
  '\\': 'Backslash',
  '.': 'Period',
  ',': 'Comma',
  '1–6': '1 to 6',
};

/** The chord in words, for assistive technology that would read "⇧⌘F" as symbols. */
export function spokenChord(chord: readonly ShortcutKey[], apple: boolean): string {
  return chord
    .map((key) =>
      key === 'Mod' ? (apple ? 'Command' : 'Control') : key === 'Alt' && apple ? 'Option' : key,
    )
    .map((key) => SPOKEN_KEYS[key] ?? key)
    .join(' ');
}
