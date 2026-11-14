import { useEffect } from 'react';
import { useEditorContext } from '@bendyline/squisq-editor-react';

/** Squisq's Write-view editor, as its context exposes it. */
type Editor = NonNullable<ReturnType<typeof useEditorContext>['tiptapEditor']>;

export interface NewDocumentCaretProps {
  /** Called once the caret is placed, or when there is nowhere to place it. */
  onPlaced: () => void;
  /**
   * What the author typed while the document was opening (`\n` for Enter),
   * collected by `startTypedWhileOpening`. Called once, after the caret is
   * placed; the text is then typed into the document.
   */
  takeTypedText?: () => string;
}

/** Type held keystrokes at the caret, one paragraph per line. */
function typeIntoDocument(editor: Editor, text: string): void {
  if (!text) return;
  const chain = editor.chain().focus();
  text.split('\n').forEach((line, index) => {
    if (index > 0) chain.splitBlock();
    // A text node, not a string: insertContent parses strings as HTML.
    if (line) chain.insertContent({ type: 'text', text: line });
  });
  chain.run();
}

/**
 * Puts the caret on an empty line beneath a just-created document's title, so
 * the author can start typing at once. A new document is only its `# Title`;
 * without this, the first keystrokes went nowhere (nothing had focus) and a
 * click on the blank page below put the caret at the end of the heading, so
 * the first sentence became part of the title.
 *
 * Renders nothing. It sits in the editor's toolbar slot only to reach the
 * editor context.
 */
export function NewDocumentCaret({ onPlaced, takeTypedText }: NewDocumentCaretProps) {
  const { activeView, tiptapEditor } = useEditorContext();

  useEffect(() => {
    if (activeView !== 'wysiwyg') {
      takeTypedText?.();
      onPlaced();
      return;
    }
    if (!tiptapEditor) return;
    // After the frame that mounts the editor: the welcome screen and the New
    // document dialog are closing in the same commit, and an editor still
    // under the welcome screen's `inert` wrapper cannot take focus.
    const frame = requestAnimationFrame(() => {
      if (!tiptapEditor.isDestroyed && tiptapEditor.isEditable) {
        tiptapEditor
          .chain()
          .command(({ tr, state }) => {
            if (state.doc.lastChild?.type.name !== 'paragraph') {
              tr.insert(state.doc.content.size, state.schema.nodes.paragraph.create());
            }
            // The empty line is where the caret starts, not an edit: nothing to
            // undo, and nothing saved until the author types. Saved, it was a
            // blank line that later edits in Source kept as an empty paragraph.
            tr.setMeta('addToHistory', false).setMeta('preventUpdate', true);
            return true;
          })
          .focus('end')
          .run();
        // Tiptap's focus command moves DOM focus a frame later. Take it now:
        // taking the typed text stops holding keys, and a key pressed in that
        // frame landed on the page and was lost ("Fat first words").
        tiptapEditor.view.focus();
        // Whatever was typed before the editor could take it.
        typeIntoDocument(tiptapEditor, takeTypedText?.() ?? '');
      } else {
        takeTypedText?.();
      }
      onPlaced();
    });
    return () => cancelAnimationFrame(frame);
  }, [activeView, tiptapEditor, onPlaced, takeTypedText]);

  return null;
}
