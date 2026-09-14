import { useEffect, useState, type RefObject } from 'react';
import { isEditorDocumentImportFile } from './import-file-types.js';

/** Matches the explorer's internal drag marker so a tree reorder never imports. */
const INTERNAL_DRAG_TYPE = 'application/x-docblocks-entry';

/**
 * Accept dropped documents on the editor pane.
 *
 * On a tablet this is the natural gesture: drag a `.docx` out of Files and onto
 * the page. The explorer has had a drop zone for a long time; the editor pane
 * has not, so the same drag two inches to the right did nothing.
 *
 * Listeners are attached natively in the capture phase on the specific element
 * rather than through React's `onDrop` prop. React attaches at the root
 * container, so prop ordering against Squisq's own drop handling is not
 * deterministic; a capture-phase listener on this node is.
 *
 * Images are excluded by `isEditorDocumentImportFile` and fall through to
 * Squisq, which inserts them into the document at the drop point.
 */
export function useEditorFileDrop(
  targetRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  onFiles: (files: File[]) => void,
): boolean {
  const [dropActive, setDropActive] = useState(false);

  useEffect(() => {
    const element = targetRef.current;
    if (!enabled || !element) {
      setDropActive(false);
      return;
    }

    // dragenter/dragleave fire for every descendant, so balance them.
    let depth = 0;

    const carriesDocument = (transfer: DataTransfer | null): boolean => {
      if (!transfer) return false;
      if (Array.from(transfer.types).includes(INTERNAL_DRAG_TYPE)) return false;
      const items = Array.from(transfer.items).filter((item) => item.kind === 'file');
      if (items.length === 0) return false;
      // During dragover the File is withheld, so fall back to the MIME type the
      // item does expose and let the drop handler make the real decision.
      return items.some((item) => {
        const file = item.getAsFile();
        return file
          ? isEditorDocumentImportFile(file)
          : !item.type.toLowerCase().startsWith('image/');
      });
    };

    const onDragEnter = (event: DragEvent): void => {
      if (!carriesDocument(event.dataTransfer)) return;
      event.preventDefault();
      depth += 1;
      setDropActive(true);
    };

    const onDragOver = (event: DragEvent): void => {
      if (!carriesDocument(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };

    const onDragLeave = (event: DragEvent): void => {
      if (!carriesDocument(event.dataTransfer)) return;
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        setDropActive(false);
      }
    };

    const onDrop = (event: DragEvent): void => {
      if (!carriesDocument(event.dataTransfer)) return;
      const files = Array.from(event.dataTransfer?.files ?? []).filter(isEditorDocumentImportFile);
      depth = 0;
      setDropActive(false);
      if (files.length === 0) return;
      // Only claim the drop once we know we have something to import, so an
      // image-only drop still reaches Squisq.
      event.preventDefault();
      event.stopPropagation();
      onFiles(files);
    };

    element.addEventListener('dragenter', onDragEnter, true);
    element.addEventListener('dragover', onDragOver, true);
    element.addEventListener('dragleave', onDragLeave, true);
    element.addEventListener('drop', onDrop, true);
    return () => {
      element.removeEventListener('dragenter', onDragEnter, true);
      element.removeEventListener('dragover', onDragOver, true);
      element.removeEventListener('dragleave', onDragLeave, true);
      element.removeEventListener('drop', onDrop, true);
      setDropActive(false);
    };
  }, [targetRef, enabled, onFiles]);

  return dropActive;
}
