import { useEffect } from 'react';
import { useEditorContext } from '@bendyline/squisq-editor-react';

export interface NewDocumentCaretProps {
  /** Called once the caret is placed, or when there is nowhere to place it. */
  onPlaced: () => void;
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
export function NewDocumentCaret({ onPlaced }: NewDocumentCaretProps) {
  const { activeView, tiptapEditor } = useEditorContext();

  useEffect(() => {
    if (activeView !== 'wysiwyg') {
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
      }
      onPlaced();
    });
    return () => cancelAnimationFrame(frame);
  }, [activeView, tiptapEditor, onPlaced]);

  return null;
}
