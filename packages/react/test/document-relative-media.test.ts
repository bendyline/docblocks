import { expect } from 'chai';
import {
  createFileMediaProvider,
  FileSystemContentContainer,
  MemoryFileSystemProvider,
  type WorkspacePath,
} from '@bendyline/docblocks/filesystem';
import {
  registerTransientWorkspace,
  unregisterTransientWorkspace,
} from '@bendyline/docblocks/workspace';
import {
  createDocumentRelativeMediaReader,
  createMediaContainer,
  looseFileMediaReader,
} from '../src/DocBlocksShell/document-relative-media.js';

const ELECTRON_ENV = {
  surface: 'electron',
  surfaceLabel: 'desktop',
  platform: 'darwin',
  appVersion: '2.7.5',
  isDev: false,
};

function installHost(host: unknown): void {
  (globalThis as { docBlocksHost?: unknown }).docBlocksHost = host;
}

function clearHost(): void {
  delete (globalThis as { docBlocksHost?: unknown }).docBlocksHost;
}

function bytes(data: ArrayBuffer | null): number[] | null {
  return data ? Array.from(new Uint8Array(data)) : null;
}

/** A loose file's session workspace, with `files` standing for its folder on disk. */
async function openLooseFile(
  id: string,
  files: Record<string, number[]>,
): Promise<{ provider: MemoryFileSystemProvider; asked: string[] }> {
  const provider = new MemoryFileSystemProvider(id, 'report.md');
  provider.seedText('report.md', '# Report\n');
  const asked: string[] = [];
  installHost({
    env: ELECTRON_ENV,
    external: {
      readText: async () => null,
      readRelativeMedia: async (resourceId: string, path: string) => {
        expect(resourceId).to.equal(`grant-${id}`);
        asked.push(path);
        const data = files[path];
        return data ? new Uint8Array(data).buffer : null;
      },
    },
  });
  registerTransientWorkspace(
    {
      id,
      name: 'report.md',
      type: 'transient',
      lastOpened: new Date(0).toISOString(),
      origin: { kind: 'loose-file', resourceId: `grant-${id}` },
    },
    provider,
  );
  return { provider, asked };
}

describe('document-relative media reader', () => {
  afterEach(clearHost);

  it('reads a reference relative to the document from the workspace', async () => {
    const provider = new MemoryFileSystemProvider('workspace', 'Workspace');
    await provider.writeBinary('reports/shots/a.png', new Uint8Array([1, 2]).buffer);
    await provider.writeBinary('shared/b.png', new Uint8Array([3]).buffer);
    const read = createDocumentRelativeMediaReader(
      new FileSystemContentContainer(provider, ''),
      'reports',
    );

    expect(bytes(await read('shots/a.png'))).to.deep.equal([1, 2]);
    expect(bytes(await read('../shared/b.png'))).to.deep.equal([3]);
    expect(await read('../../escape.png')).to.equal(null);
    expect(await read('shots/missing.png')).to.equal(null);
  });

  it('shows a loose file’s relative and sidecar media from beside it', async () => {
    const { provider, asked } = await openLooseFile('transient-external-file-r1', {
      'shots/journey/j02.png': [9],
      'report_files/pasted.png': [8],
    });
    const originalCreate = URL.createObjectURL;
    const created: Blob[] = [];
    URL.createObjectURL = (blob: Blob) => {
      created.push(blob);
      return `blob:loose-${created.length}`;
    };
    try {
      const readBeside = looseFileMediaReader(provider.id);
      const media = createFileMediaProvider(
        createMediaContainer(provider, '', readBeside),
        'report.md',
        {
          readDocumentRelative: createDocumentRelativeMediaReader(
            createMediaContainer(provider, '', readBeside),
            '',
          ),
        },
      );
      expect(await media.resolveUrl('shots/journey/j02.png')).to.equal('blob:loose-1');
      expect(await media.resolveUrl('report_files/pasted.png')).to.equal('blob:loose-2');
      // The legacy bare spelling names the same sidecar file.
      expect(await media.resolveUrl('pasted.png')).to.equal('blob:loose-2');
      expect(bytes(await created[0]!.arrayBuffer())).to.deep.equal([9]);
      expect(bytes(await created[1]!.arrayBuffer())).to.deep.equal([8]);
      expect(await media.resolveUrl('../outside.png')).to.equal('../outside.png');
      expect(await media.resolveUrl('notes.md')).to.equal('notes.md');
      media.dispose();
      // Nothing that is not a confined media path reaches the host.
      expect(asked.every((path) => !path.includes('..') && !path.endsWith('.md'))).to.equal(true);
    } finally {
      URL.createObjectURL = originalCreate;
      await unregisterTransientWorkspace(provider.id);
    }
  });

  it('prefers what the session workspace holds over the disk', async () => {
    const { provider, asked } = await openLooseFile('transient-external-file-r2', {
      'report_files/a.png': [1],
    });
    try {
      await provider.writeBinary('report_files/a.png', new Uint8Array([2]).buffer);
      const container = createMediaContainer(provider, '', looseFileMediaReader(provider.id));
      expect(bytes(await container.readFile('report_files/a.png'))).to.deep.equal([2]);
      expect(asked).to.deep.equal([]);
    } finally {
      await unregisterTransientWorkspace(provider.id);
    }
  });

  it('treats a refused host read as absence', async () => {
    const provider = new MemoryFileSystemProvider('refusing', 'report.md');
    const container = createMediaContainer(provider, '', async () => {
      throw new Error('Relative media must be a regular file');
    });
    expect(await container.readFile('shots/linked.png')).to.equal(null);
  });

  it('offers no host read for other workspaces or hosts without the capability', async () => {
    const provider = new MemoryFileSystemProvider('transient-external-bundle-b1', 'deck.dbk');
    installHost({
      env: ELECTRON_ENV,
      external: {
        readText: async () => null,
        readRelativeMedia: async (): Promise<ArrayBuffer | null> => {
          throw new Error('A bundle must not read beside itself');
        },
      },
    });
    registerTransientWorkspace(
      {
        id: provider.id,
        name: 'deck.dbk',
        type: 'transient',
        lastOpened: new Date(0).toISOString(),
        origin: { kind: 'dbk', resourceId: 'external_b1', version: null },
      },
      provider,
    );
    try {
      expect(looseFileMediaReader(provider.id)).to.equal(null);
      expect(looseFileMediaReader('workspace-not-transient')).to.equal(null);
    } finally {
      await unregisterTransientWorkspace(provider.id);
    }

    const loose = new MemoryFileSystemProvider('transient-external-file-r3', 'old.md');
    installHost({ env: ELECTRON_ENV, external: { readText: async () => null } });
    registerTransientWorkspace(
      {
        id: loose.id,
        name: 'old.md',
        type: 'transient',
        lastOpened: new Date(0).toISOString(),
        origin: { kind: 'loose-file', resourceId: 'external_r3' },
      },
      loose,
    );
    try {
      expect(looseFileMediaReader(loose.id)).to.equal(null);
    } finally {
      await unregisterTransientWorkspace(loose.id);
    }
  });

  it('resolves the reference as written into a workspace path', async () => {
    const provider = new MemoryFileSystemProvider('written', 'r.md');
    const seen: WorkspacePath[] = [];
    const read = createDocumentRelativeMediaReader(
      createMediaContainer(provider, '', async (path) => {
        seen.push(path);
        return null;
      }),
      '',
    );
    await read('./shots/my%20shot.png?v=1');
    expect(seen).to.deep.equal(['shots/my shot.png']);
  });
});
