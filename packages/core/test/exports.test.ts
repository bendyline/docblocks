import { expect } from 'chai';
import {
  isNativeFileSystemSupported,
  NativeFileSystemProvider,
  IndexedDBFileSystemProvider,
} from '@bendyline/docblocks/filesystem';
import type {
  FileSystemEntry,
  FileEntry,
  FolderEntry,
  FileMeta,
} from '@bendyline/docblocks/filesystem';
import type { WorkspaceDescriptor } from '@bendyline/docblocks/workspace';

describe('Core exports', () => {
  describe('filesystem', () => {
    it('exports NativeFileSystemProvider class', () => {
      expect(NativeFileSystemProvider).to.be.a('function');
    });

    it('exports IndexedDBFileSystemProvider class', () => {
      expect(IndexedDBFileSystemProvider).to.be.a('function');
    });

    it('isNativeFileSystemSupported returns false in Node', () => {
      // Node doesn't have showDirectoryPicker
      expect(isNativeFileSystemSupported()).to.equal(false);
    });
  });

  describe('types', () => {
    it('WorkspaceDescriptor type is structurally sound', () => {
      const ws: WorkspaceDescriptor = {
        id: 'test-1',
        name: 'Test Workspace',
        type: 'indexeddb',
        lastOpened: new Date().toISOString(),
      };
      expect(ws.id).to.equal('test-1');
      expect(ws.name).to.equal('Test Workspace');
      expect(ws.type).to.equal('indexeddb');
      expect(ws.lastOpened).to.be.a('string');
    });

    it('WorkspaceDescriptor supports native type', () => {
      const ws: WorkspaceDescriptor = {
        id: 'native-folder-123',
        name: 'My Folder',
        type: 'native',
        lastOpened: '2025-01-01T00:00:00.000Z',
      };
      expect(ws.type).to.equal('native');
    });

    it('FileSystemEntry types are correct', () => {
      const file: FileEntry = { kind: 'file', name: 'readme.md', path: 'readme.md' };
      const folder: FolderEntry = { kind: 'directory', name: 'docs', path: 'docs' };
      const entries: FileSystemEntry[] = [folder, file];

      expect(entries).to.have.length(2);
      expect(entries[0].kind).to.equal('directory');
      expect(entries[1].kind).to.equal('file');
    });

    it('FileMeta has expected shape', () => {
      const meta: FileMeta = {
        name: 'test.md',
        path: 'docs/test.md',
        size: 256,
        lastModified: '2025-06-01T12:00:00.000Z',
      };
      expect(meta.name).to.equal('test.md');
      expect(meta.size).to.equal(256);
    });
  });
});

describe('FileSystemProvider interface', () => {
  it('IndexedDBFileSystemProvider implements all expected methods', () => {
    const proto = IndexedDBFileSystemProvider.prototype;
    const expectedMethods = [
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

    for (const method of expectedMethods) {
      expect(proto).to.have.property(method).that.is.a('function');
    }
  });

  it('NativeFileSystemProvider implements all expected methods', () => {
    const proto = NativeFileSystemProvider.prototype;
    const expectedMethods = [
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

    for (const method of expectedMethods) {
      expect(proto).to.have.property(method).that.is.a('function');
    }
  });
});
