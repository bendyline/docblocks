import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { SHELL_SHORTCUTS } from '../src/DocBlocksShell/keyboard-shortcuts.js';
import { displayKeys, shortcutSheet, spokenChord } from '../src/DocBlocksShell/shortcut-sheet.js';
import { KeyboardShortcutsDialog } from '../src/DocBlocksShell/KeyboardShortcutsDialog.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

function shellSection(nativeHost: boolean) {
  const section = shortcutSheet({ nativeHost }).find((s) => s.title === 'Documents and files');
  if (!section) throw new Error('missing shell section');
  return section;
}

describe('keyboard shortcut sheet', () => {
  it('lists every shell action the table binds, from the table itself', () => {
    const listed = new Set(shellSection(true).entries.map((entry) => entry.action));
    for (const binding of SHELL_SHORTCUTS) {
      if (binding.action) expect(listed.has(binding.action), binding.action).to.equal(true);
    }
    // Escape closes the phone drawer; it is plumbing, not a listed action.
    expect([...listed].some((action) => /drawer|overlay/i.test(action))).to.equal(false);
  });

  it('groups F1 and ? under one entry', () => {
    const entry = shellSection(true).entries.find((e) => e.action === 'Show keyboard shortcuts');
    expect(entry?.chords).to.deep.equal([['F1'], ['?']]);
  });

  it('leaves out chords a browser tab keeps for itself', () => {
    const web = shellSection(false).entries.map((entry) => entry.action);
    expect(web).not.to.include('New document');
    expect(web).not.to.include('New folder');
    const native = shellSection(true).entries.map((entry) => entry.action);
    expect(native).to.include('New document');
  });

  it('draws Ctrl on Windows and Linux, and ordered symbols on Apple platforms', () => {
    expect(displayKeys(['Mod', 'Shift', 'F'], false)).to.deep.equal(['Ctrl', 'Shift', 'F']);
    expect(displayKeys(['Mod', 'Shift', 'F'], true)).to.deep.equal(['⇧', '⌘', 'F']);
    expect(displayKeys(['Mod', 'Alt', '1–6'], true)).to.deep.equal(['⌥', '⌘', '1–6']);
    expect(spokenChord(['Mod', 'Shift', 'F'], true)).to.equal('Command Shift F');
    expect(spokenChord(['Mod', '\\'], false)).to.equal('Control Backslash');
  });

  it('renders each section with its keys and spoken chords', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let closed = 0;
    try {
      await act(async () => {
        root.render(
          createElement(KeyboardShortcutsDialog, {
            onClose: () => {
              closed += 1;
            },
          }),
        );
      });
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.textContent).to.include('Keyboard shortcuts');
      const headings = [...document.querySelectorAll('.db-shortcuts-heading')].map(
        (heading) => heading.textContent,
      );
      expect(headings).to.deep.equal([
        'Documents and files',
        'Views',
        'Formatting in Write',
        'Slideshow',
      ]);
      const save = [...document.querySelectorAll('.db-shortcuts-row')].find(
        (row) => row.querySelector('dt')?.textContent === 'Save now',
      );
      expect(
        [...(save?.querySelectorAll('kbd') ?? [])].map((key) => key.textContent),
      ).to.deep.equal(['Ctrl', 'S']);
      expect(save?.querySelector('.db-visually-hidden')?.textContent).to.equal('Control S');

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(closed).to.equal(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
