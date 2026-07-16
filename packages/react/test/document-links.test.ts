import { expect } from 'chai';
import type {
  FileMeta,
  FileSystemEntry,
  FileSystemProvider,
} from '@bendyline/docblocks/filesystem';
import {
  collectMarkdownFiles,
  createDocumentLinkCandidates,
  DocumentDiscoveryError,
} from '../src/DocBlocksShell/document-links.js';

type DirectoryTree = Readonly<Record<string, readonly FileSystemEntry[]>>;

function providerFor(tree: DirectoryTree): FileSystemProvider {
  return {
    id: 'links',
    label: 'Links',
    async readDirectory(path) {
      return [...(tree[path] ?? [])];
    },
    async readFile() {
      return null;
    },
    async writeFile() {},
    async delete() {},
    async rename() {},
    async exists() {
      return false;
    },
    async createDirectory() {},
    async stat(): Promise<FileMeta | null> {
      return null;
    },
    async readBinary() {
      return null;
    },
    async writeBinary() {},
  };
}

describe('document link discovery', () => {
  const file = (name: string, path = name): FileSystemEntry => ({ kind: 'file', name, path });
  const directory = (name: string, path = name): FileSystemEntry => ({
    kind: 'directory',
    name,
    path,
  });

  it('skips implementation folders and returns stable relative candidates', async () => {
    const provider = providerFor({
      '': [
        file('root.md'),
        directory('docs'),
        directory('.git'),
        directory('node_modules'),
        directory('root_files'),
      ],
      docs: [file('zeta.md', 'docs/zeta.md'), file('alpha.md', 'docs/alpha.md')],
    });
    const entries = await collectMarkdownFiles(provider, '');
    expect(entries.map((entry) => entry.path)).to.have.members([
      'root.md',
      'docs/zeta.md',
      'docs/alpha.md',
    ]);
    expect(createDocumentLinkCandidates(entries, 'docs/zeta.md', '')).to.deep.equal([
      { path: 'alpha.md', label: 'alpha', description: 'docs' },
      { path: '../root.md', label: 'root' },
    ]);
  });

  it('rejects an entry traversal that exceeds its budget', async () => {
    const provider = providerFor({ '': [file('one.md'), file('two.md')] });
    let caught: unknown;
    try {
      await collectMarkdownFiles(provider, '', { maxEntries: 1 });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(DocumentDiscoveryError);
    expect(caught).to.include({ code: 'limit' });
  });

  it('cancels a stalled provider read', async () => {
    const provider = providerFor({});
    provider.readDirectory = () => new Promise<FileSystemEntry[]>(() => undefined);
    const controller = new AbortController();
    const pending = collectMarkdownFiles(provider, '', {
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    controller.abort(new Error('workspace changed'));
    let caught: unknown;
    try {
      await pending;
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.equal('workspace changed');
  });
});
