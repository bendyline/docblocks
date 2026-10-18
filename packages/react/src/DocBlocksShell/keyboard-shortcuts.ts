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
 *   Cmd+1 through Cmd+6     headings
 *   Cmd+Shift+1/2/3         view tabs
 *   Cmd+K                   link
 *   Cmd+Z / Cmd+Shift+Z     history
 * and the browser's own Cmd+W, Cmd+T, Cmd+L.
 *
 * Cmd+F is claimed deliberately: Squisq's find bar covers Write, Source and
 * Use, so the shell takes the key before Monaco's own find widget or the
 * browser's page search (which cannot see Monaco's virtualized lines).
 * Cmd+P is claimed for quick-open, the convention in code and note editors;
 * printing stays available from the editor's Use view.
 */
export type ShellShortcutId =
  | 'save'
  | 'find'
  | 'quick-open'
  | 'workspace-search'
  | 'toggle-sidebar'
  | 'focus-files'
  | 'new-document'
  | 'new-folder'
  | 'shortcuts'
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
  /**
   * Fires while the caret is in the document editor (Squisq's surface or
   * Monaco), though not in other text fields such as a dialog's name box.
   */
  readonly whileEditing?: boolean;
  /** What the key does, as the shortcut sheet lists it. Unlisted when absent. */
  readonly action?: string;
  /**
   * Browsers keep this chord for themselves (Ctrl+N opens a window), so it
   * reaches the app only in a native host and the sheet lists it only there.
   */
  readonly browserReserved?: boolean;
}

export const SHELL_SHORTCUTS: readonly ShortcutBinding[] = Object.freeze([
  // Must work mid-sentence; that is the entire point of a save shortcut.
  { id: 'save', key: 's', accel: true, label: 'Ctrl+S', whileTyping: true, action: 'Save now' },
  // Find is mostly invoked from inside the document being searched.
  {
    id: 'find',
    key: 'f',
    accel: true,
    label: 'Ctrl+F',
    whileTyping: true,
    action: 'Find in document',
  },
  // Jumping elsewhere is as likely mid-sentence as from the tree.
  {
    id: 'quick-open',
    key: 'p',
    accel: true,
    label: 'Ctrl+P',
    whileTyping: true,
    action: 'Go to document',
  },
  {
    id: 'workspace-search',
    key: 'f',
    accel: true,
    shift: true,
    label: 'Ctrl+Shift+F',
    whileTyping: true,
    action: 'Search the workspace',
  },
  // Deliberately NOT Cmd+B — Squisq owns that for Bold. Cmd+\ is the VS Code
  // convention for toggling the side bar.
  {
    id: 'toggle-sidebar',
    key: '\\',
    accel: true,
    label: 'Ctrl+\\',
    whileTyping: true,
    action: 'Show or hide the file pane',
  },
  // Leaving a text field for the files is the point of this key — the search
  // box included, which Ctrl+Shift+F has just focused. It only moves focus.
  {
    id: 'focus-files',
    key: 'e',
    accel: true,
    shift: true,
    label: 'Ctrl+Shift+E',
    whileTyping: true,
    action: 'Move focus to the files',
  },
  // Starting another document is most often done from inside one. A dialog's
  // own name box keeps these keys, so a second prompt can't stack.
  {
    id: 'new-document',
    key: 'n',
    accel: true,
    label: 'Ctrl+N',
    whileEditing: true,
    action: 'New document',
    browserReserved: true,
  },
  {
    id: 'new-folder',
    key: 'n',
    accel: true,
    shift: true,
    label: 'Ctrl+Shift+N',
    whileEditing: true,
    action: 'New folder',
    browserReserved: true,
  },
  // F1 is the help key and works mid-sentence; `?` is the web convention but
  // is ordinary text while typing. Both open the same sheet.
  {
    id: 'shortcuts',
    key: 'F1',
    accel: false,
    label: 'F1',
    whileTyping: true,
    action: 'Show keyboard shortcuts',
  },
  { id: 'shortcuts', key: '?', accel: false, shift: true, label: '?' },
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
  if (isDocumentEditorTarget(target)) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** True inside the document editor itself: Squisq's WYSIWYG surface or Monaco. */
function isDocumentEditorTarget(target: HTMLElement): boolean {
  return target.isContentEditable || target.closest('.monaco-editor') !== null;
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
  return SHELL_SHORTCUTS.find((binding) => bindingMatches(binding, event))?.id ?? null;
}

function bindingMatches(binding: ShortcutBinding, event: KeyboardEvent): boolean {
  // AltGr composes characters on several keyboard layouts; never bind through it.
  if (event.altKey) return false;
  const accel = event.ctrlKey || event.metaKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (binding.accel !== accel) return false;
  if ((binding.shift ?? false) !== event.shiftKey) return false;
  if (binding.key !== key) return false;
  if (binding.whileTyping === true || !isTypingTarget(event.target)) return true;
  return (
    binding.whileEditing === true &&
    event.target instanceof HTMLElement &&
    isDocumentEditorTarget(event.target)
  );
}

/**
 * Cmd/Ctrl+F, for hosts that mount Squisq's `EditorShell` without the shell's
 * listener (the VS Code webview) but still want one find UI everywhere.
 */
export function isFindShortcut(event: KeyboardEvent): boolean {
  const binding = SHELL_SHORTCUTS.find((candidate) => candidate.id === 'find');
  return binding !== undefined && bindingMatches(binding, event);
}

/** Tooltip label for the find shortcut on the current platform. */
export function findShortcutLabel(): string {
  return shortcutLabel('find', isApplePlatform());
}

/** True on macOS and iOS, where shortcuts are labelled with ⌘ rather than Ctrl. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/u.test(navigator.platform || navigator.userAgent);
}

/** Platform-appropriate label, for menus and `title` attributes. */
export function shortcutLabel(id: ShellShortcutId, isApple: boolean): string {
  const binding = SHELL_SHORTCUTS.find((candidate) => candidate.id === id);
  if (!binding) return '';
  return isApple ? binding.label.replace('Ctrl+', '⌘') : binding.label;
}
