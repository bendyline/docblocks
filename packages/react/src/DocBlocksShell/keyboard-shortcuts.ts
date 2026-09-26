import type { DbLayoutMode } from '../layout/form-factor.js';

/**
 * Shell-level keyboard shortcuts.
 *
 * A declarative table plus one capture listener, rather than one bare listener
 * per shortcut. The shell had exactly one (Cmd+S) written as its own effect;
 * eight of those would be unreviewable and would fight each other for
 * `stopPropagation`.
 *
 * Squisq owns the editing keys. Anything bound here must avoid them:
 *   Cmd+B / Cmd+I / Cmd+U   formatting
 *   Cmd+1 / Cmd+2 / Cmd+3   view tabs
 *   Cmd+K                   link
 *   Cmd+Z / Cmd+Shift+Z     history
 * and the browser's own Cmd+P, Cmd+W, Cmd+T, Cmd+L.
 */
export type ShellShortcutId =
  | 'save'
  | 'toggle-sidebar'
  | 'focus-files'
  | 'new-document'
  | 'new-folder'
  | 'close-overlay';

export interface ShortcutBinding {
  readonly id: ShellShortcutId;
  /** Compared case-insensitively against `KeyboardEvent.key`. */
  readonly key: string;
  /** Requires Ctrl (or Cmd on Apple platforms). */
  readonly accel: boolean;
  readonly shift?: boolean;
  /** Human-readable accelerator for menus and tooltips. */
  readonly label: string;
  /** Fires even while the caret is in a text field. */
  readonly whileTyping?: boolean;
}

export const SHELL_SHORTCUTS: readonly ShortcutBinding[] = Object.freeze([
  // Must work mid-sentence; that is the entire point of a save shortcut.
  { id: 'save', key: 's', accel: true, label: 'Ctrl+S', whileTyping: true },
  // Deliberately NOT Cmd+B — Squisq owns that for Bold. Cmd+\ is the VS Code
  // convention for toggling the side bar.
  { id: 'toggle-sidebar', key: '\\', accel: true, label: 'Ctrl+\\', whileTyping: true },
  { id: 'focus-files', key: 'e', accel: true, shift: true, label: 'Ctrl+Shift+E' },
  { id: 'new-document', key: 'n', accel: true, label: 'Ctrl+N' },
  { id: 'new-folder', key: 'n', accel: true, shift: true, label: 'Ctrl+Shift+N' },
  // Ctrl+, (settings) is deliberately absent: AppMenu owns that dialog's state
  // internally and exposes no way to open it. Binding the key without first
  // giving AppMenu a controlled `settingsOpen` prop would ship a dead shortcut.
  { id: 'close-overlay', key: 'Escape', accel: false, label: 'Esc', whileTyping: true },
]);

/**
 * True when the event target is somewhere the user is composing text, so a
 * bare-key shortcut must not steal it. Monaco renders a real textarea, and
 * Squisq's WYSIWYG surface is contenteditable.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.closest('.monaco-editor') !== null;
}

/**
 * Resolve an event to a shortcut id, or null.
 *
 * `layoutMode` is accepted so a binding can be made layout-specific later; no
 * current binding differs by layout, and returning the same id in both keeps
 * the handler map simple.
 */
export function matchShortcut(
  event: KeyboardEvent,
  _layoutMode: DbLayoutMode,
): ShellShortcutId | null {
  // AltGr composes characters on several keyboard layouts; never bind through it.
  if (event.altKey) return null;
  const accel = event.ctrlKey || event.metaKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

  for (const binding of SHELL_SHORTCUTS) {
    if (binding.accel !== accel) continue;
    if ((binding.shift ?? false) !== event.shiftKey) continue;
    if (binding.key !== key) continue;
    if (!binding.whileTyping && isTypingTarget(event.target)) continue;
    return binding.id;
  }
  return null;
}

/** Platform-appropriate label, for menus and `title` attributes. */
export function shortcutLabel(id: ShellShortcutId, isApple: boolean): string {
  const binding = SHELL_SHORTCUTS.find((candidate) => candidate.id === id);
  if (!binding) return '';
  return isApple ? binding.label.replace('Ctrl+', '⌘') : binding.label;
}
