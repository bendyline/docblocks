import { expect } from 'chai';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import {
  placeNewDocumentCaret,
  retitleNewDocument,
} from '../src/DocBlocksShell/placeNewDocumentCaret.js';

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

/**
 * A document from the New document gallery is named in the toolbar's title
 * field after it opens. Its `# Heading` started as the same name, so it
 * follows the new one; and a template's caret selects its first line of
 * sample text, so typing replaces it.
 */
describe('a document named after it opened', () => {
  let editor: Editor;

  function open(html: string): void {
    const element = document.createElement('div');
    document.body.append(element);
    editor = new Editor({ element, extensions: [StarterKit], content: html });
  }

  afterEach(() => {
    editor.destroy();
    document.body.replaceChildren();
  });

  it('renames the heading that still has the starting name', () => {
    open('<h1>Untitled</h1><p>Body</p>');
    retitleNewDocument(editor as unknown as CaretEditor, 'Untitled', 'Trip notes');
    expect(editor.getText({ blockSeparator: '|' })).to.equal('Trip notes|Body');
  });

  it('leaves a heading the person already changed, or one that is not the title', () => {
    open('<h1>My own title</h1>');
    retitleNewDocument(editor as unknown as CaretEditor, 'Untitled', 'Trip notes');
    expect(editor.getText()).to.equal('My own title');
    editor.destroy();
    open('<h2>Untitled</h2>');
    retitleNewDocument(editor as unknown as CaretEditor, 'Untitled', 'Trip notes');
    expect(editor.getText()).to.equal('Untitled');
  });

  it('selects a template’s first sample line, so typing replaces it', () => {
    open('<h1>Project plan</h1><h2>Goals</h2><p>What this plan delivers.</p><p>More</p>');
    placeNewDocumentCaret(editor as unknown as CaretEditor, () => 'Ship by June.', {
      at: 'sample',
    });
    expect(editor.getText({ blockSeparator: '|' })).to.equal(
      'Project plan|Goals|Ship by June.|More',
    );
    expect(editor.view.hasFocus()).to.equal(true);
  });

  it('falls back to a new line at the end when a template has no sample line', () => {
    open('<h1>Budget</h1><h2>Income</h2>');
    placeNewDocumentCaret(editor as unknown as CaretEditor, () => 'Note', { at: 'sample' });
    expect(editor.getText({ blockSeparator: '|' })).to.equal('Budget|Income|Note');
  });
});
