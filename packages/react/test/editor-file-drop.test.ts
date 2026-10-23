/**
 * The editor pane imports dropped documents, but must leave media drops to
 * Squisq, which inserts an image or a video/audio player at the drop point.
 * During dragover a dragged file exposes only its MIME type, so the decision
 * to claim the drag (and show "Drop to import") rests on that type alone.
 */
import { expect } from 'chai';
import type { RefObject } from 'react';
import { act, renderHook } from './helpers/renderHook.js';
import {
  isEditorDocumentImportFile,
  isEditorMediaMimeType,
} from '../src/DocBlocksShell/import-file-types.js';
import { useEditorFileDrop } from '../src/DocBlocksShell/useEditorFileDrop.js';

function dragEvent(type: string, itemTypes: string[], files: File[] = []): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      files,
      items: itemTypes.map((itemType) => ({
        kind: 'file',
        type: itemType,
        getAsFile: () => null,
      })),
      types: ['Files'],
      dropEffect: 'none',
    },
  });
  return event;
}

describe('editor pane media drops', () => {
  it('names images, video and audio as media Squisq inserts itself', () => {
    expect(isEditorMediaMimeType('video/mp4')).to.equal(true);
    expect(isEditorMediaMimeType('audio/mpeg')).to.equal(true);
    expect(isEditorMediaMimeType('image/png')).to.equal(true);
    expect(isEditorMediaMimeType('application/pdf')).to.equal(false);
    expect(isEditorMediaMimeType('')).to.equal(false);
  });

  it('never treats a dropped video or audio file as a document import', () => {
    expect(isEditorDocumentImportFile({ name: 'clip.mp4', type: 'video/mp4' })).to.equal(false);
    expect(isEditorDocumentImportFile({ name: 'take.mp3', type: 'audio/mpeg' })).to.equal(false);
    expect(isEditorDocumentImportFile({ name: 'take.mp3', type: '' })).to.equal(false);
    expect(isEditorDocumentImportFile({ name: 'notes.md', type: 'text/markdown' })).to.equal(true);
  });

  it('claims a document drag but lets a video or audio drag through', async () => {
    const element = document.createElement('div');
    document.body.append(element);
    const ref: RefObject<HTMLElement | null> = { current: element };
    const imported: File[][] = [];
    const hook = await renderHook(
      () => useEditorFileDrop(ref, true, (files) => imported.push(files)),
      undefined,
    );

    try {
      const mediaOver = dragEvent('dragover', ['video/mp4', 'audio/mpeg']);
      await act(async () => {
        element.dispatchEvent(dragEvent('dragenter', ['video/mp4', 'audio/mpeg']));
        element.dispatchEvent(mediaOver);
      });
      expect(mediaOver.defaultPrevented).to.equal(false);
      expect(hook.result.current).to.equal(false);

      const video = new File([new Uint8Array([1])], 'clip.mp4', { type: 'video/mp4' });
      const mediaDrop = dragEvent('drop', ['video/mp4'], [video]);
      await act(async () => {
        element.dispatchEvent(mediaDrop);
      });
      expect(mediaDrop.defaultPrevented).to.equal(false);
      expect(imported).to.deep.equal([]);

      const docxType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const documentOver = dragEvent('dragover', [docxType]);
      await act(async () => {
        element.dispatchEvent(dragEvent('dragenter', [docxType]));
        element.dispatchEvent(documentOver);
      });
      expect(documentOver.defaultPrevented).to.equal(true);
      // The affordance survives the re-render that switching it on causes.
      expect(hook.result.current).to.equal(true);

      const report = new File([new Uint8Array([1])], 'report.docx', { type: docxType });
      const documentDrop = dragEvent('drop', [docxType], [report]);
      await act(async () => {
        element.dispatchEvent(documentDrop);
      });
      expect(documentDrop.defaultPrevented).to.equal(true);
      expect(imported.map((files) => files.map((file) => file.name))).to.deep.equal([
        ['report.docx'],
      ]);
      expect(hook.result.current).to.equal(false);
    } finally {
      await hook.unmount();
      element.remove();
    }
  });
});
