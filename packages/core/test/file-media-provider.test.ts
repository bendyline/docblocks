import { expect } from 'chai';
import { MemoryContentContainer } from '@bendyline/squisq/storage';
import { createFileSystemDocumentTarget, DocumentSession } from '../src/document/index.js';
import { FileSystemContentContainer } from '../src/filesystem/filesystem-content-container.js';
import { createFileMediaProvider } from '../src/filesystem/file-media-provider.js';
import { MemoryFileSystemProvider } from '../src/filesystem/memory-provider.js';

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

  it('keeps a nested recording byte-for-byte across document save and media reload', async () => {
    const { probe, restore } = installObjectUrlProbe();
    try {
      const filesystem = new MemoryFileSystemProvider('recording', 'Recording');
      filesystem.seedText('notes.md', '# Notes\n');
      const container = new FileSystemContentContainer(filesystem, '');
      const provider = createFileMediaProvider(container, 'notes.md');
      const recording = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
      const recordingPath = 'notes_files/video/camera+audio-capture.webm';

      expect(
        await provider.addMedia(
          'video/camera+audio-capture.webm',
          new Blob([recording], { type: 'video/webm' }),
          'video/webm',
        ),
      ).to.equal(recordingPath);

      const session = new DocumentSession({ autoSaveDelayMs: 60_000 });
      await session.transitionTo(
        createFileSystemDocumentTarget(filesystem, 'notes.md'),
        '# Notes\n',
      );
      const scope = session.getSnapshot();
      if (!scope.targetKey) throw new Error('Test session has no document target.');
      session.edit(`# Notes\n\n<video src="${recordingPath}" controls></video>\n`, {
        targetKey: scope.targetKey,
        generation: scope.generation,
      });
      await session.flush('manual');

      provider.dispose();
      const reopened = createFileMediaProvider(
        new FileSystemContentContainer(filesystem, ''),
        'notes.md',
      );
      expect(await reopened.listMedia()).to.deep.equal([
        {
          name: recordingPath,
          mimeType: 'video/webm',
          size: recording.byteLength,
        },
      ]);
      expect(await reopened.resolveUrl(recordingPath)).to.equal('blob:media-2');
      expect(probe.created[1]?.type).to.equal('video/webm');
      expect(
        Array.from(new Uint8Array((await container.readFile(recordingPath)) ?? new ArrayBuffer(0))),
      ).to.deep.equal(Array.from(recording));
      expect(await filesystem.readFile('notes.md')).to.contain(recordingPath);
      reopened.dispose();
    } finally {
      restore();
    }
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

  it('displays a durable upload without rereading it or scanning the workspace', async () => {
    const { probe, restore } = installObjectUrlProbe();
    const container = new MemoryContentContainer();
    const provider = createFileMediaProvider(container, 'notes.md');
    try {
      const bytes = new Uint8Array([0, 1, 2, 3]).subarray(1, 3);
      await provider.addMedia('photo', bytes, 'image/png');
      container.readFile = async () => {
        throw new Error('The uploaded bytes should already be cached');
      };
      container.listFiles = async () => {
        throw new Error('Displaying an upload must not scan unrelated files');
      };
      expect(await provider.resolveUrl('notes_files/photo')).to.equal('blob:media-1');
      expect(probe.created[0]?.type).to.equal('image/png');
      expect(Array.from(new Uint8Array(await probe.created[0]!.arrayBuffer()))).to.deep.equal([
        1, 2,
      ]);
    } finally {
      provider.dispose();
      restore();
    }
  });

  it('shares concurrent resolutions and revokes the single URL', async () => {
    const { probe, restore } = installObjectUrlProbe();
    const container = new MemoryContentContainer();
    await container.writeFile('notes_files/photo.png', new Uint8Array([1]), 'image/png');
    const provider = createFileMediaProvider(container, 'notes.md');
    try {
      const urls = await Promise.all([
        provider.resolveUrl('photo.png'),
        provider.resolveUrl('/notes_files/photo.png'),
      ]);
      expect(urls).to.deep.equal(['blob:media-1', 'blob:media-1']);
      provider.dispose();
      expect(probe.created).to.have.length(1);
      expect(probe.revoked).to.deep.equal(['blob:media-1']);
    } finally {
      provider.dispose();
      restore();
    }
  });

  it('returns each original reference when concurrent aliases are missing', async () => {
    const provider = createFileMediaProvider(new MemoryContentContainer(), 'notes.md');
    expect(
      await Promise.all([
        provider.resolveUrl('missing.png'),
        provider.resolveUrl('/notes_files/missing.png'),
      ]),
    ).to.deep.equal(['missing.png', '/notes_files/missing.png']);
    provider.dispose();
  });

  it('does not replace a new upload with an older in-flight read', async () => {
    const { probe, restore } = installObjectUrlProbe();
    const container = new MemoryContentContainer();
    await container.writeFile('notes_files/photo.png', new Uint8Array([1]), 'image/png');
    const provider = createFileMediaProvider(container, 'notes.md');
    let finishRead!: (data: ArrayBuffer) => void;
    container.readFile = () =>
      new Promise((resolve) => {
        finishRead = resolve;
      });
    try {
      const reading = provider.resolveUrl('photo.png');
      await provider.addMedia('photo.png', new Uint8Array([2]), 'image/png');
      finishRead(new Uint8Array([1]).buffer);
      expect(await reading).to.equal(await provider.resolveUrl('photo.png'));
      expect(probe.created).to.have.length(1);
      expect(Array.from(new Uint8Array(await probe.created[0]!.arrayBuffer()))).to.deep.equal([2]);
    } finally {
      provider.dispose();
      restore();
    }
  });

  it('does not create a URL when disposed during an upload', async () => {
    const { probe, restore } = installObjectUrlProbe();
    const container = new MemoryContentContainer();
    const provider = createFileMediaProvider(container, 'notes.md');
    let finishWrite!: () => void;
    container.writeFile = () =>
      new Promise((resolve) => {
        finishWrite = resolve;
      });
    try {
      const uploading = provider.addMedia('photo.png', new Uint8Array([1]), 'image/png');
      provider.dispose();
      finishWrite();
      await uploading;
      expect(probe.created).to.have.length(0);
    } finally {
      restore();
    }
  });
});
