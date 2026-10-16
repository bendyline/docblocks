import { expect } from 'chai';
import {
  SHELL_SHORTCUTS,
  isFindShortcut,
  isTypingTarget,
  matchShortcut,
  shortcutLabel,
} from '../src/DocBlocksShell/keyboard-shortcuts.js';

interface KeyOptions {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | null;
}

function keyEvent({ key, ctrlKey, metaKey, shiftKey, altKey, target }: KeyOptions): KeyboardEvent {
  return {
    key,
    ctrlKey: ctrlKey ?? false,
    metaKey: metaKey ?? false,
    shiftKey: shiftKey ?? false,
    altKey: altKey ?? false,
    target: target ?? null,
  } as unknown as KeyboardEvent;
}

describe('shell keyboard shortcuts', () => {
  it('matches the accelerator on both Ctrl and Cmd', () => {
    expect(matchShortcut(keyEvent({ key: 's', ctrlKey: true }), 'split-pane')).to.equal('save');
    expect(matchShortcut(keyEvent({ key: 's', metaKey: true }), 'split-pane')).to.equal('save');
  });

  it('is case-insensitive but distinguishes Shift as a modifier', () => {
    expect(matchShortcut(keyEvent({ key: 'N', metaKey: true }), 'split-pane')).to.equal(
      'new-document',
    );
    expect(
      matchShortcut(keyEvent({ key: 'n', metaKey: true, shiftKey: true }), 'split-pane'),
    ).to.equal('new-folder');
  });

  it('never fires through Alt', () => {
    // AltGr composes characters on several layouts; binding through it would
    // steal real typing.
    expect(
      matchShortcut(keyEvent({ key: 's', ctrlKey: true, altKey: true }), 'split-pane'),
    ).to.equal(null);
  });

  it('requires the accelerator for accelerator bindings', () => {
    expect(matchShortcut(keyEvent({ key: 's' }), 'split-pane')).to.equal(null);
  });

  it('lets Escape and Ctrl+S through while the caret is in a text field', () => {
    const input = document.createElement('input');
    expect(matchShortcut(keyEvent({ key: 'Escape', target: input }), 'single-pane')).to.equal(
      'close-overlay',
    );
    expect(
      matchShortcut(keyEvent({ key: 's', metaKey: true, target: input }), 'single-pane'),
    ).to.equal('save');
  });

  it('claims Ctrl+F from inside the editor so one find bar serves every view', () => {
    const monaco = document.createElement('div');
    monaco.className = 'monaco-editor';
    const textarea = document.createElement('textarea');
    monaco.append(textarea);
    expect(
      matchShortcut(keyEvent({ key: 'f', ctrlKey: true, target: textarea }), 'split-pane'),
    ).to.equal('find');
    expect(isFindShortcut(keyEvent({ key: 'F', metaKey: true, target: textarea }))).to.equal(true);
  });

  it('opens quick-open and workspace search from inside a text field', () => {
    const input = document.createElement('input');
    expect(
      matchShortcut(keyEvent({ key: 'p', ctrlKey: true, target: input }), 'split-pane'),
    ).to.equal('quick-open');
    expect(
      matchShortcut(
        keyEvent({ key: 'F', metaKey: true, shiftKey: true, target: input }),
        'split-pane',
      ),
    ).to.equal('workspace-search');
  });

  it('recognises only the plain find chord for hosts without the shell listener', () => {
    expect(isFindShortcut(keyEvent({ key: 'f' }))).to.equal(false);
    expect(isFindShortcut(keyEvent({ key: 'f', ctrlKey: true, shiftKey: true }))).to.equal(false);
    expect(isFindShortcut(keyEvent({ key: 'f', ctrlKey: true, altKey: true }))).to.equal(false);
    expect(isFindShortcut(keyEvent({ key: 's', ctrlKey: true }))).to.equal(false);
  });

  it('suppresses non-typing bindings inside a text field', () => {
    const textarea = document.createElement('textarea');
    expect(
      matchShortcut(keyEvent({ key: 'n', metaKey: true, target: textarea }), 'split-pane'),
    ).to.equal(null);
  });

  describe('isTypingTarget', () => {
    it('recognises inputs, textareas, selects and contenteditable', () => {
      for (const tag of ['input', 'textarea', 'select']) {
        expect(isTypingTarget(document.createElement(tag)), tag).to.equal(true);
      }
      const editable = document.createElement('div');
      editable.setAttribute('contenteditable', 'true');
      // happy-dom does not always derive isContentEditable from the attribute.
      Object.defineProperty(editable, 'isContentEditable', { value: true });
      expect(isTypingTarget(editable)).to.equal(true);
    });

    it('recognises the Monaco surface by ancestor', () => {
      const monaco = document.createElement('div');
      monaco.className = 'monaco-editor';
      const inner = document.createElement('span');
      monaco.append(inner);
      expect(isTypingTarget(inner)).to.equal(true);
    });

    it('does not treat ordinary elements as typing targets', () => {
      expect(isTypingTarget(document.createElement('button'))).to.equal(false);
      expect(isTypingTarget(null)).to.equal(false);
    });
  });

  it('collides with none of the keys Squisq or the browser own', () => {
    // Squisq: bold/italic/underline, the three view tabs, link, history.
    // Browser: close, new tab, address bar. Print (Cmd+P) is deliberately
    // claimed for quick-open; printing stays in the editor's Use view.
    const reserved = [
      { key: 'b', accel: true, shift: false },
      { key: 'i', accel: true, shift: false },
      { key: 'u', accel: true, shift: false },
      { key: 'k', accel: true, shift: false },
      { key: 'z', accel: true, shift: false },
      { key: 'z', accel: true, shift: true },
      { key: '1', accel: true, shift: false },
      { key: '2', accel: true, shift: false },
      { key: '3', accel: true, shift: false },
      { key: '4', accel: true, shift: false },
      { key: '5', accel: true, shift: false },
      { key: '6', accel: true, shift: false },
      { key: '1', accel: true, shift: true },
      { key: '2', accel: true, shift: true },
      { key: '3', accel: true, shift: true },
      { key: 'w', accel: true, shift: false },
      { key: 't', accel: true, shift: false },
      { key: 'l', accel: true, shift: false },
    ];
    for (const combo of reserved) {
      const clash = SHELL_SHORTCUTS.find(
        (binding) =>
          binding.key === combo.key &&
          binding.accel === combo.accel &&
          (binding.shift ?? false) === combo.shift,
      );
      expect(clash, `shell shortcut ${clash?.id} collides with a reserved key`).to.equal(undefined);
    }
  });

  it('declares no duplicate chords', () => {
    const seen = new Set<string>();
    for (const binding of SHELL_SHORTCUTS) {
      const chord = `${binding.accel ? 'accel+' : ''}${binding.shift ? 'shift+' : ''}${binding.key}`;
      expect(seen.has(chord), `duplicate chord ${chord}`).to.equal(false);
      seen.add(chord);
    }
  });

  it('renders platform-appropriate labels', () => {
    expect(shortcutLabel('save', false)).to.equal('Ctrl+S');
    expect(shortcutLabel('save', true)).to.equal('⌘S');
    expect(shortcutLabel('find', true)).to.equal('⌘F');
  });

  it('opens the shortcut sheet from F1 anywhere and from ? outside text', () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    document.body.append(editor);
    try {
      expect(matchShortcut(keyEvent({ key: 'F1', target: editor }), 'split-pane')).to.equal(
        'shortcuts',
      );
      expect(matchShortcut(keyEvent({ key: '?', shiftKey: true }), 'split-pane')).to.equal(
        'shortcuts',
      );
      // `?` is ordinary text while writing.
      expect(
        matchShortcut(keyEvent({ key: '?', shiftKey: true, target: editor }), 'split-pane'),
      ).to.equal(null);
    } finally {
      editor.remove();
    }
  });
});
