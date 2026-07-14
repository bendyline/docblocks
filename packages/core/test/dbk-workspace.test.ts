import { expect } from 'chai';
import { MemoryContentContainer, type ContentContainer } from '@bendyline/squisq/storage';
import {
  MemoryFileSystemProvider,
  createDbkWorkspaceSnapshot,
  replaceMemoryWorkspaceFromDbk,
} from '../src/filesystem/index.js';

const encoder = new TextEncoder();

function encoded(value: string): Uint8Array {
  return encoder.encode(value);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('DBK transient workspace reconciliation', () => {
  it('replaces the Markdown tree atomically and deletes stale workspace entries', async () => {
    const provider = new MemoryFileSystemProvider('bundle', 'Bundle');
    await provider.writeFile('/bundle.md', '# local');
    await provider.writeBinary('/bundle_files/stale.png', new Uint8Array([9]));
    await provider.writeFile('/unrelated.md', 'stale');

    const external = new MemoryContentContainer();
    await external.writeFile('index.md', encoded('# external'), 'text/markdown');
    await external.writeFile('appendix.md', encoded('# appendix'), 'text/markdown');

    const result = await replaceMemoryWorkspaceFromDbk(provider, external, {
      targetDocumentPath: '/bundle.md',
    });

    expect(result.assetLayout).to.equal('companion');
    expect(result.documentContent).to.equal('# external');
    expect(await provider.readFile('/bundle.md')).to.equal('# external');
    expect(await provider.readFile('/bundle_files/appendix.md')).to.equal('# appendix');
    expect(await provider.exists('/bundle_files/stale.png')).to.equal(false);
    expect(await provider.exists('/unrelated.md')).to.equal(false);
  });

  it('preserves an already workspace-shaped DBK without nesting its companion twice', async () => {
    const provider = new MemoryFileSystemProvider('bundle', 'Bundle');
    const external = new MemoryContentContainer();
    await external.writeFile('bundle.md', encoded('# external'), 'text/markdown');
    await external.writeFile('bundle_files/appendix.md', encoded('# appendix'), 'text/markdown');

    const result = await replaceMemoryWorkspaceFromDbk(provider, external, {
      targetDocumentPath: '/bundle.md',
    });

    expect(result.assetLayout).to.equal('preserve');
    expect(await provider.exists('/bundle_files/appendix.md')).to.equal(true);
    expect(await provider.exists('/bundle_files/bundle_files/appendix.md')).to.equal(false);
  });

  it('preserves secondary markdown as readable workspace text', async () => {
    const provider = new MemoryFileSystemProvider('bundle', 'Bundle');
    const external = new MemoryContentContainer();
    await external.writeFile('bundle.md', encoded('# primary'), 'text/markdown');
    await external.writeFile('appendix.md', encoded('# appendix'), 'text/markdown');

    await replaceMemoryWorkspaceFromDbk(provider, external, {
      targetDocumentPath: '/bundle.md',
    });

    expect(await provider.readFile('/appendix.md')).to.equal('# appendix');
    expect(await provider.readBinary('/appendix.md')).to.equal(null);
  });

  it('does not mutate the provider when an external DBK entry cannot be read', async () => {
    const provider = new MemoryFileSystemProvider('bundle', 'Bundle');
    await provider.writeFile('/bundle.md', '# original');
    await provider.writeBinary('/bundle_files/original.png', new Uint8Array([8]));

    const backing = new MemoryContentContainer();
    await backing.writeFile('index.md', encoded('# replacement'), 'text/markdown');
    await backing.writeFile('z-broken.md', encoded('# broken'), 'text/markdown');
    const failing: ContentContainer = {
      readFile: (path) =>
        path === 'z-broken.md'
          ? Promise.reject(new Error('simulated DBK read failure'))
          : backing.readFile(path),
      writeFile: (path, data, mimeType) => backing.writeFile(path, data, mimeType),
      removeFile: (path) => backing.removeFile(path),
      listFiles: (prefix) => backing.listFiles(prefix),
      exists: (path) => backing.exists(path),
      getDocumentPath: () => backing.getDocumentPath(),
      readDocument: () => backing.readDocument(),
      writeDocument: (markdown, filename) => backing.writeDocument(markdown, filename),
    };

    let thrown: unknown;
    try {
      await replaceMemoryWorkspaceFromDbk(provider, failing, {
        targetDocumentPath: '/bundle.md',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(Error);
    expect(await provider.readFile('/bundle.md')).to.equal('# original');
    expect([
      ...new Uint8Array((await provider.readBinary('/bundle_files/original.png'))!),
    ]).to.deep.equal([8]);
    expect(await provider.exists('/bundle_files/z-broken.md')).to.equal(false);
  });

  it('does not overwrite provider changes made while the DBK snapshot is being read', async () => {
    const provider = new MemoryFileSystemProvider('bundle', 'Bundle');
    await provider.writeFile('/bundle.md', '# original');
    const backing = new MemoryContentContainer();
    await backing.writeFile('index.md', encoded('# replacement'), 'text/markdown');
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    const delayed: ContentContainer = {
      readFile: async (path) => {
        readStarted.resolve();
        await releaseRead.promise;
        return backing.readFile(path);
      },
      writeFile: (path, data, mimeType) => backing.writeFile(path, data, mimeType),
      removeFile: (path) => backing.removeFile(path),
      listFiles: (prefix) => backing.listFiles(prefix),
      exists: (path) => backing.exists(path),
      getDocumentPath: () => backing.getDocumentPath(),
      readDocument: () => backing.readDocument(),
      writeDocument: (markdown, filename) => backing.writeDocument(markdown, filename),
    };

    const replacing = replaceMemoryWorkspaceFromDbk(provider, delayed, {
      targetDocumentPath: '/bundle.md',
    });
    await readStarted.promise;
    await provider.writeBinary('/bundle_files/local.png', new Uint8Array([7]));
    releaseRead.resolve();

    let thrown: unknown;
    try {
      await replacing;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).to.be.instanceOf(Error);
    expect((thrown as Error).message).to.include('changed while replacement contents were staged');
    expect(await provider.readFile('/bundle.md')).to.equal('# original');
    expect(await provider.exists('/bundle_files/local.png')).to.equal(true);
  });

  it('rejects unsafe container paths before replacement', async () => {
    const provider = new MemoryFileSystemProvider('bundle', 'Bundle');
    await provider.writeFile('/bundle.md', '# original');
    const external = new MemoryContentContainer();
    await external.writeFile('index.md', encoded('# replacement'), 'text/markdown');
    await external.writeFile('../escape.md', encoded('# escape'), 'text/markdown');

    let thrown: unknown;
    try {
      await replaceMemoryWorkspaceFromDbk(provider, external, {
        targetDocumentPath: '/bundle.md',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(Error);
    expect(await provider.readFile('/bundle.md')).to.equal('# original');
    expect(await provider.exists('/bundle_files/escape.md')).to.equal(false);
  });

  it('rejects any non-Markdown member before reading or replacing the workspace', async () => {
    const provider = new MemoryFileSystemProvider('bundle', 'Bundle');
    await provider.writeFile('/bundle.md', '# original');
    const external = new MemoryContentContainer();
    await external.writeFile('index.md', encoded('# replacement'), 'text/markdown');
    await external.writeFile('image.png', new Uint8Array([1, 2, 3]), 'image/png');

    let thrown: unknown;
    try {
      await replaceMemoryWorkspaceFromDbk(provider, external, {
        targetDocumentPath: '/bundle.md',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(Error);
    expect((thrown as Error).message).to.include('only Markdown (.md) files are allowed');
    expect(await provider.readFile('/bundle.md')).to.equal('# original');
  });

  it('rejects invalid UTF-8 and NUL-bearing Markdown as corrupt text', async () => {
    for (const bytes of [new Uint8Array([0xc3, 0x28]), encoded('# bad\0text')]) {
      const external = new MemoryContentContainer();
      await external.writeFile('index.md', bytes, 'text/markdown');
      let thrown: unknown;
      try {
        await createDbkWorkspaceSnapshot(external, { targetDocumentPath: 'draft.md' });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).to.be.instanceOf(Error);
    }
  });

  it('can stage a deterministic snapshot without mutating the target provider', async () => {
    const external = new MemoryContentContainer();
    await external.writeFile('index.md', encoded('# staged'), 'text/markdown');
    await external.writeFile('b.md', encoded('# B'), 'text/markdown');
    await external.writeFile('a.md', encoded('# A'), 'text/markdown');

    const snapshot = await createDbkWorkspaceSnapshot(external, {
      targetDocumentPath: 'draft.md',
    });

    expect(snapshot.files.map((file) => file.path)).to.deep.equal([
      'draft_files/a.md',
      'draft_files/b.md',
      'draft.md',
    ]);
  });
});
