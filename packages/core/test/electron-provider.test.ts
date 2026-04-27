/**
 * Unit tests for ElectronFileSystemProvider.
 *
 * The provider is a pure IPC client — we install a mock `docBlocksHost`
 * on globalThis and assert that each method delegates correctly with the
 * right arguments.
 */

import { expect } from 'chai';
import { ElectronFileSystemProvider, isElectronHost } from '@bendyline/docblocks/filesystem';
import type { DocBlocksHostAPI } from '@bendyline/docblocks/host';

function installMockHost(fsImpl: Partial<DocBlocksHostAPI['fs']>): { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fs = new Proxy(fsImpl, {
    get(target, key: string) {
      if (key in target) return (target as Record<string, unknown>)[key];
      return (...args: unknown[]) => {
        calls.push([key, ...args]);
        return Promise.resolve(null);
      };
    },
  });
  (globalThis as unknown as { docBlocksHost: Partial<DocBlocksHostAPI> }).docBlocksHost = {
    fs: fs as DocBlocksHostAPI['fs'],
  };
  return { calls };
}

function clearHost(): void {
  delete (globalThis as { docBlocksHost?: unknown }).docBlocksHost;
}

describe('ElectronFileSystemProvider', () => {
  afterEach(clearHost);

  it('isElectronHost() is false without a host', () => {
    expect(isElectronHost()).to.equal(false);
  });

  it('isElectronHost() is true once docBlocksHost is installed', () => {
    installMockHost({});
    expect(isElectronHost()).to.equal(true);
  });

  it('delegates readFile with the root path and relative path', async () => {
    const { calls } = installMockHost({
      readFile: async (root, p) => {
        return `content:${root}:${p}`;
      },
    });
    const provider = new ElectronFileSystemProvider('ws-1', 'My Docs', '/tmp/docs');
    const result = await provider.readFile('/notes/today.md');
    expect(result).to.equal('content:/tmp/docs:/notes/today.md');
    expect(calls).to.be.an('array');
  });

  it('stores and returns the root path', () => {
    installMockHost({});
    const provider = new ElectronFileSystemProvider('ws-2', 'Docs', '/home/me/DocBlocks');
    expect(provider.getRootPath()).to.equal('/home/me/DocBlocks');
    expect(provider.id).to.equal('ws-2');
    expect(provider.label).to.equal('Docs');
  });

  it('writeFile forwards content', async () => {
    let captured: { root?: string; path?: string; content?: string } = {};
    installMockHost({
      writeFile: async (root, p, content) => {
        captured = { root, path: p, content };
      },
    });
    const provider = new ElectronFileSystemProvider('ws-3', 'w', '/r');
    await provider.writeFile('/a/b.md', 'hello');
    expect(captured).to.deep.equal({ root: '/r', path: '/a/b.md', content: 'hello' });
  });

  it('implements every FileSystemProvider method', () => {
    installMockHost({});
    const proto = ElectronFileSystemProvider.prototype;
    const expected = [
      'readFile',
      'writeFile',
      'delete',
      'rename',
      'readDirectory',
      'exists',
      'createDirectory',
      'stat',
      'readBinary',
      'writeBinary',
    ];
    for (const m of expected) {
      expect(proto).to.have.property(m).that.is.a('function');
    }
  });

  it('throws a helpful error when no host is installed', async () => {
    clearHost();
    const provider = new ElectronFileSystemProvider('x', 'y', '/z');
    let err: unknown;
    try {
      await provider.readFile('/a.md');
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an('error');
    expect((err as Error).message).to.include('docBlocksHost');
  });
});
