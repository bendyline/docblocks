import { expect } from 'chai';
import { startTypedWhileOpening } from '../src/DocBlocksShell/typedWhileOpening.js';

/**
 * After Create, the New document dialog closes before the new document's
 * editor can take focus. Keys typed in between used to be lost; the buffer
 * keeps them for NewDocumentCaret to type once the caret is placed.
 */
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

function type(text: string): void {
  for (const character of text) press(character === '\n' ? 'Enter' : character);
}

describe('startTypedWhileOpening', () => {
  afterEach(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.replaceChildren();
  });

  it('keeps printable keys, Enter and Backspace typed with nothing focused', () => {
    const buffer = startTypedWhileOpening();
    type('Two days by the waterx');
    press('Backspace');
    type('.\nNext line');
    expect(buffer.take()).to.equal('Two days by the water.\nNext line');
  });

  it('keeps the keys from the page, so Enter cannot reopen the dialog', () => {
    const button = document.createElement('button');
    document.body.append(button);
    let clicks = 0;
    button.addEventListener('keydown', () => clicks++);
    button.focus();
    const buffer = startTypedWhileOpening();
    const enter = press('Enter');
    expect(enter.defaultPrevented).to.equal(true);
    expect(clicks).to.equal(0);
    expect(buffer.take()).to.equal('\n');
  });

  it('leaves shortcuts and navigation keys alone', () => {
    const buffer = startTypedWhileOpening();
    expect(press('s', { ctrlKey: true }).defaultPrevented).to.equal(false);
    expect(press('Tab').defaultPrevented).to.equal(false);
    expect(press('Escape').defaultPrevented).to.equal(false);
    expect(buffer.take()).to.equal('');
  });

  it('stops holding keys once a form field has focus', () => {
    const buffer = startTypedWhileOpening();
    type('Hi');
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    expect(press('x').defaultPrevented).to.equal(false);
    expect(buffer.take()).to.equal('Hi');
  });

  it('keeps holding keys when the app focuses an editor before the caret is placed', () => {
    // The shell focuses the outgoing document's editor as the welcome screen
    // closes; a key let through there landed in the wrong document.
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    document.body.append(editor);
    const buffer = startTypedWhileOpening();
    type('Two ');
    editor.focus();
    const d = press('d');
    expect(d.defaultPrevented).to.equal(true);
    type('ays');
    expect(buffer.take()).to.equal('Two days');
  });

  it('lets go when the person clicks, keeping what was typed', () => {
    const buffer = startTypedWhileOpening();
    type('Hi');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(press('x').defaultPrevented).to.equal(false);
    expect(buffer.take()).to.equal('Hi');
  });

  it('stops listening after take or cancel', () => {
    const taken = startTypedWhileOpening();
    taken.take();
    expect(press('a').defaultPrevented).to.equal(false);

    const cancelled = startTypedWhileOpening();
    type('abc');
    cancelled.cancel();
    expect(cancelled.take()).to.equal('');
    expect(press('b').defaultPrevented).to.equal(false);
  });

  it('forgets what was typed after the timeout', async () => {
    const buffer = startTypedWhileOpening(document, 20);
    type('late');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(buffer.take()).to.equal('');
    expect(press('z').defaultPrevented).to.equal(false);
  });
});
