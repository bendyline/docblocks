import type { useEditorContext } from '@bendyline/squisq-editor-react';
import { isFormField } from './typedWhileOpening.js';

/** Squisq's Write-view editor, as its context exposes it. */
export type NewDocumentEditor = NonNullable<ReturnType<typeof useEditorContext>['tiptapEditor']>;

/**
 * Type held keystrokes at the caret, one paragraph per line.
 *
 * One command per step, not one chain: Tiptap's `splitBlock` maps the caret
 * through every earlier step of its transaction, so after a line typed in the
 * same chain it split past the end ("Position 30 out of range") and the rest
 * was lost. History still groups the steps into one undo. No `focus()`
 * either: Tiptap's moves DOM focus a frame later, even when the caller
 * decided not to take it.
 */
function typeIntoDocument(editor: NewDocumentEditor, text: string): void {
  text.split('\n').forEach((line, index) => {
    if (index > 0) editor.commands.splitBlock();
    // A text node, not a string: insertContent parses strings as HTML.
    if (line) editor.commands.insertContent({ type: 'text', text: line });
  });
}

/**
 * Put the caret on an empty line beneath a new document's title, give the
 * editor focus, then type what was held while it opened (`takeTypedText` is
 * called only once focus is in place, so no key falls between the two).
 *
 * Focus stays where it is when the person has moved on to a form field
 * outside the editor (they opened New Folder, or search) while the document
 * was opening. The editor can take seconds to mount, and taking focus then
 * sent the rest of their typing into the document. The caret and the held
 * text still go in, ready for when they come back.
 */
export function placeNewDocumentCaret(
  editor: NewDocumentEditor,
  takeTypedText: () => string,
): void {
  const active = editor.view.dom.ownerDocument.activeElement;
  const movedOn = isFormField(active) && !editor.view.dom.contains(active);
  editor
    .chain()
    .command(({ tr, state, commands }) => {
      if (state.doc.lastChild?.type.name !== 'paragraph') {
        tr.insert(state.doc.content.size, state.schema.nodes.paragraph.create());
      }
      // The empty line is where the caret starts, not an edit: nothing to
      // undo, and nothing saved until the author types. Saved, it was a
      // blank line that later edits in Source kept as an empty paragraph.
      tr.setMeta('addToHistory', false).setMeta('preventUpdate', true);
      // The document's end clamps to its last line. Not `focus('end')`: that
      // moves DOM focus a frame later, by when the person may be elsewhere.
      return commands.setTextSelection(tr.doc.content.size);
    })
    .run();
  // Take focus now rather than a frame later: taking the typed text stops
  // holding keys, and a key pressed in that frame landed on the page and was
  // lost ("Fat first words").
  if (!movedOn) editor.view.focus();
  // Whatever was typed before the editor could take it.
  typeIntoDocument(editor, takeTypedText());
}
