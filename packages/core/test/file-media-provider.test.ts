import { expect } from 'chai';
import { MemoryContentContainer } from '@bendyline/squisq/storage';
import { createFileMediaProvider } from '../src/filesystem/file-media-provider.js';

interface ObjectUrlProbe {
  created: Blob[];
  revoked: string[];
}

function installObjectUrlProbe(): { probe: ObjectUrlProbe; restore: () => void } {
  const createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  const probe: ObjectUrlProbe = { created: [], revoked: [] };
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      probe.created.push(blob);
      return `blob:media-${probe.created.length}`;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: (url: string) => probe.revoked.push(url),
  });
  return {
    probe,
    restore: () => {
      if (createDescriptor) Object.defineProperty(URL, 'createObjectURL', createDescriptor);
      else Reflect.deleteProperty(URL, 'createObjectURL');
      if (revokeDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor);
      else Reflect.deleteProperty(URL, 'revokeObjectURL');
    },
  };
}

describe('file media provider', () => {
  it('stores bare and folder-qualified media under the markdown sidecar', async () => {
    const container = new MemoryContentContainer();
    const provider = createFileMediaProvider(container, 'notes.md');

    expect(await provider.addMedia('image.png', new Uint8Array([1, 2]), 'image/png')).to.equal(
      'notes_files/image.png',
    );
    expect(
      await provider.addMedia(
        '/notes_files/audio.mp3',
        new Blob([new Uint8Array([3, 4, 5])]),
        'audio/mpeg',
      ),
    ).to.equal('notes_files/audio.mp3');
    await container.writeFile(
      'notes_files/implementation.md',
      new TextEncoder().encode('hidden'),
      'text/markdown',
    );

    const listed = await provider.listMedia();
    expect([...listed].sort((left, right) => left.name.localeCompare(right.name))).to.deep.equal([
      { name: 'notes_files/audio.mp3', mimeType: 'audio/mpeg', size: 3 },
      { name: 'notes_files/image.png', mimeType: 'image/png', size: 2 },
    ]);
  });

  it('resolves equivalent references once and returns missing references unchanged', async () => {
    const { probe, restore } = installObjectUrlProbe();
    try {
      const container = new MemoryContentContainer();
      await container.writeFile('notes_files/photo.png', new Uint8Array([1]), 'image/png');
      const provider = createFileMediaProvider(container, 'notes.md');

      expect(await provider.resolveUrl('photo.png')).to.equal('blob:media-1');
      expect(await provider.resolveUrl('/notes_files/photo.png')).to.equal('blob:media-1');
      expect(await provider.resolveUrl('missing.png')).to.equal('missing.png');
      expect(probe.created).to.have.length(1);
      expect(probe.created[0]?.type).to.equal('image/png');
    } finally {
      restore();
    }
  });

  it('revokes cached URLs on replacement, removal, and disposal', async () => {
    const { probe, restore } = installObjectUrlProbe();
    try {
      const container = new MemoryContentContainer();
      await container.writeFile('notes_files/one.png', new Uint8Array([1]), 'image/png');
      await container.writeFile('notes_files/two.png', new Uint8Array([2]), 'image/png');
      const provider = createFileMediaProvider(container, 'notes.md');

      expect(await provider.resolveUrl('one.png')).to.equal('blob:media-1');
      await provider.addMedia('one.png', new Uint8Array([3]), 'image/png');
      expect(probe.revoked).to.deep.equal(['blob:media-1']);
      expect(await provider.resolveUrl('one.png')).to.equal('blob:media-2');
      await provider.removeMedia('one.png');
      expect(probe.revoked).to.deep.equal(['blob:media-1', 'blob:media-2']);
      expect(await provider.resolveUrl('two.png')).to.equal('blob:media-3');
      provider.dispose();
      expect(probe.revoked).to.deep.equal(['blob:media-1', 'blob:media-2', 'blob:media-3']);
      expect(await container.readFile('notes_files/one.png')).to.equal(null);
    } finally {
      restore();
    }
  });

  it('propagates storage failures instead of publishing fallback media', async () => {
    class FailingContainer extends MemoryContentContainer {
      override async readFile(): Promise<never> {
        throw new DOMException('permission revoked', 'NotAllowedError');
      }
    }

    const provider = createFileMediaProvider(new FailingContainer(), 'notes.md');
    let failure: unknown;
    try {
      await provider.resolveUrl('image.png');
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(DOMException);
    expect((failure as DOMException).name).to.equal('NotAllowedError');
  });
});
