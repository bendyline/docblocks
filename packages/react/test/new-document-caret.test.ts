import { expect } from 'chai';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import { placeNewDocumentCaret } from '../src/DocBlocksShell/placeNewDocumentCaret.js';

type CaretEditor = Parameters<typeof placeNewDocumentCaret>[0];

/** Two animation frames: Tiptap's own focus command moved focus one frame late. */
async function afterFrames(): Promise<void> {
  for (let frame = 0; frame < 2; frame++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

/**
 * A just-created document is only its `# Title`. Once its editor mounts, the
 * caret goes on an empty line beneath the title and the keys held while it
 * opened are typed there. That can be seconds after Create, so the person may
 * have moved on to another field by then.
 */
describe('placing the caret in a new document', () => {
  let editor: Editor;

  beforeEach(() => {
    const element = document.createElement('div');
    document.body.append(element);
    editor = new Editor({ element, extensions: [StarterKit], content: '<h1>Field notes</h1>' });
  });

  afterEach(() => {
    editor.destroy();
    document.body.replaceChildren();
  });

  function caretText(): string {
    return editor.state.selection.$from.parent.textContent;
  }

  it('puts the caret on a new line beneath the title and takes focus', async () => {
    placeNewDocumentCaret(editor as unknown as CaretEditor, () => '');

    expect(editor.getJSON().content?.map((node) => node.type)).to.deep.equal([
      'heading',
      'paragraph',
    ]);
    expect(editor.state.selection.$from.parent.type.name).to.equal('paragraph');
    expect(editor.view.hasFocus()).to.equal(true);
    // The empty line is not an edit to undo.
    expect(editor.can().undo()).to.equal(false);
    await afterFrames();
    expect(editor.view.hasFocus()).to.equal(true);
  });

  it('types what was held, a paragraph per line, after taking focus', () => {
    let focusedWhenTaken = false;
    placeNewDocumentCaret(editor as unknown as CaretEditor, () => {
      focusedWhenTaken = editor.view.hasFocus();
      return 'Two days\nby the water';
    });

    expect(focusedWhenTaken).to.equal(true);
    // A line then Enter once split past the end of the document and threw.
    expect(editor.getText({ blockSeparator: '|' })).to.equal('Field notes|Two days|by the water');
    expect(caretText()).to.equal('by the water');
    // What was typed is one edit to undo; the caret's empty line never was.
    editor.commands.undo();
    expect(editor.getText({ blockSeparator: '|' })).to.equal('Field notes|');
  });

  it('keeps an Enter typed last as an empty line to carry on from', () => {
    placeNewDocumentCaret(editor as unknown as CaretEditor, () => 'Two days\n');

    expect(editor.getText({ blockSeparator: '|' })).to.equal('Field notes|Two days|');
    expect(caretText()).to.equal('');
  });

  it('leaves focus in a form field the person moved on to', async () => {
    // They opened New Folder and started naming it while the document opened.
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();

    placeNewDocumentCaret(editor as unknown as CaretEditor, () => 'Hi');

    expect(document.activeElement).to.equal(field);
    // The caret and the held text still go in, ready for when they come back.
    expect(editor.getText({ blockSeparator: '|' })).to.equal('Field notes|Hi');
    expect(caretText()).to.equal('Hi');
    await afterFrames();
    expect(document.activeElement).to.equal(field);
  });

  it('takes focus from a button, which is not somewhere to type', () => {
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();

    placeNewDocumentCaret(editor as unknown as CaretEditor, () => '');

    expect(editor.view.hasFocus()).to.equal(true);
  });
});
