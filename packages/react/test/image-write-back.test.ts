import { expect } from 'chai';
import {
  FsError,
  MemoryFileSystemProvider,
  imageEditCompanionPath,
  isEditableImagePath,
  type FileSystemProvider,
} from '@bendyline/docblocks/filesystem';
import { createImageWriteBack } from '../src/DocBlocksShell/image-write-back.js';

/** A picture's bytes as the editor hands them over. */
function picture(...bytes: number[]): Blob {
  const data = new Uint8Array(bytes);
  return { arrayBuffer: async () => data.slice().buffer } as Blob;
}

describe('image write-back', () => {
  it('writes the flattened picture over the image file and reports it', async () => {
    const fs = new MemoryFileSystemProvider('image-write-back', 'Images');
    await fs.writeBinary('shots/photo.png', new Uint8Array([1, 1, 1]));
    const written: Array<{ bytes: number[]; mimeType: string }> = [];
    const writeBack = createImageWriteBack({
      provider: fs,
      path: 'shots/photo.png',
      onWritten: (data, mimeType) => written.push({ bytes: [...new Uint8Array(data)], mimeType }),
      onLeaveFailed: () => expect.fail('nothing failed'),
    });

    await writeBack(picture(7, 8, 9), 'png', { reason: 'save' });

    expect([...new Uint8Array((await fs.readBinary('shots/photo.png'))!)]).to.deep.equal([7, 8, 9]);
    expect(written).to.deep.equal([{ bytes: [7, 8, 9], mimeType: 'image/png' }]);
    await fs.v2.dispose();
  });

  it('turns a failed save into plain words for the editor to show', async () => {
    const failing = {
      writeBinary: async () => {
        throw new FsError('quota-exceeded', 'QuotaExceededError: IDB transaction aborted', {
          operation: 'write',
          path: 'photo.jpg',
        });
      },
    } as unknown as FileSystemProvider;
    const leaveFailures: string[] = [];
    const writeBack = createImageWriteBack({
      provider: failing,
      path: 'photo.jpg',
      onWritten: () => expect.fail('nothing was written'),
      onLeaveFailed: (message) => leaveFailures.push(message),
    });

    let message = '';
    try {
      await writeBack(picture(1), 'jpeg', { reason: 'save' });
    } catch (error: unknown) {
      message = (error as Error).message;
    }

    expect(message).to.equal(
      'Your changes to “photo.jpg” weren’t saved. There is no room left to save it.',
    );
    expect(message).not.to.contain('IDB');
    // The editor is still open to show it; no second report.
    expect(leaveFailures).to.deep.equal([]);
  });

  it('reports a failed write-back on leave, when no editor is left to show it', async () => {
    const failing = {
      writeBinary: async () => {
        throw new TypeError('Failed to fetch');
      },
    } as unknown as FileSystemProvider;
    const leaveFailures: string[] = [];
    const writeBack = createImageWriteBack({
      provider: failing,
      path: 'art/hero.webp',
      onWritten: () => expect.fail('nothing was written'),
      onLeaveFailed: (message) => leaveFailures.push(message),
    });

    let rejected = false;
    await writeBack(picture(1), 'webp', { reason: 'leave' }).catch(() => {
      rejected = true;
    });

    expect(rejected).to.equal(true);
    expect(leaveFailures).to.deep.equal(['Your changes to “hero.webp” weren’t saved. Try again.']);
  });
});

describe('image companions', () => {
  it('names the layers folder after the whole file name', () => {
    expect(imageEditCompanionPath('shots/photo.png')).to.equal('shots/photo.png_files');
    expect(imageEditCompanionPath('/photo.JPG')).to.equal('/photo.JPG_files');
  });

  it('edits only formats that save back losslessly', () => {
    for (const path of ['a.png', 'b.JPG', 'c.jpeg', 'd.webp']) {
      expect(isEditableImagePath(path), path).to.equal(true);
    }
    for (const path of ['a.gif', 'b.svg', 'c.avif', 'd.bmp', 'e.ico', 'png']) {
      expect(isEditableImagePath(path), path).to.equal(false);
    }
  });
});
