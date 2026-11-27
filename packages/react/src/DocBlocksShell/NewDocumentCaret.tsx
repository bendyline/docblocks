import { useEffect } from 'react';
import { useEditorContext } from '@bendyline/squisq-editor-react';
import { placeNewDocumentCaret, retitleNewDocument } from './placeNewDocumentCaret.js';

export interface NewDocumentCaretProps {
  /** Called once the caret is placed, or when there is nowhere to place it. */
  onPlaced: () => void;
  /**
   * What the author typed while the document was opening (`\n` for Enter),
   * collected by `startTypedWhileOpening`. Called once, after the caret is
   * placed; the text is then typed into the document.
   */
  takeTypedText?: () => string;
  /**
   * The document was just named: its `# Heading` still reading `from`
   * becomes `to`.
   */
  retitle?: { from: string; to: string } | null;
  /** `sample` selects a template's first line of sample text instead. */
  at?: 'end' | 'sample';
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
export function NewDocumentCaret({
  onPlaced,
  takeTypedText,
  retitle = null,
  at = 'end',
}: NewDocumentCaretProps) {
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
        if (retitle) retitleNewDocument(tiptapEditor, retitle.from, retitle.to);
        placeNewDocumentCaret(tiptapEditor, () => takeTypedText?.() ?? '', { at });
      } else {
        takeTypedText?.();
      }
      onPlaced();
    });
    return () => cancelAnimationFrame(frame);
    // `retitle` is read once, as the caret is placed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, tiptapEditor, onPlaced, takeTypedText, at]);

  return null;
}
