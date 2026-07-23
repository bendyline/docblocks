import { expect } from 'chai';
import * as coreRoot from '../src/index.js';
import { IndexedDBFileSystemProvider } from '@bendyline/docblocks/filesystem/indexeddb';
import { MemoryFileSystemProvider } from '@bendyline/docblocks/filesystem/memory';
import {
  isNativeFileSystemSupported,
  NativeFileSystemProvider,
} from '@bendyline/docblocks/filesystem/native';
import { ElectronFileSystemProvider } from '@bendyline/docblocks/filesystem/electron';
import type {
  FileSystemEntry,
  FileEntry,
  FolderEntry,
  FileMeta,
} from '@bendyline/docblocks/filesystem';
import type { WorkspaceDescriptor } from '@bendyline/docblocks/workspace';

describe('Core exports', () => {
  it('keeps the intentionally stable root surface explicit', () => {
    expect(Object.keys(coreRoot).sort()).to.deep.equal([
      'DOCUMENT_RECOVERY_JOURNAL_SCHEMA_VERSION',
      'DOCUMENT_RECOVERY_JOURNAL_STORAGE_KEY',
      'DocumentCommitConflictError',
      'DocumentRecoveryJournal',
      'DocumentSession',
      'DocumentSessionConflictError',
      'ELECTRON_FILE_SYSTEM_V2_CAPABILITIES',
      'ElectronFileSystemProvider',
      'ElectronFileSystemProviderV2',
      'FileSystemContentContainer',
      'FileSystemMoveRecoveryError',
      'FileSystemPartialMoveError',
      'FsError',
      'HOST_WIRE_LIMITS',
      'IndexedDBContentContainer',
      'IndexedDBFileSystemProvider',
      'IndexedDBFileSystemProviderV2',
      'LegacyFileSystemProviderV2Adapter',
      'MAX_HOST_PINNED_DOCUMENTS',
      'MemoryFileSystemProvider',
      'MemoryFileSystemProviderV2',
      'NativeFileSystemMoveRecoveryError',
      'NativeFileSystemProvider',
      'NativeFileSystemProviderV2',
      'SHARED_DOCUMENT_LIMITS',
      'WORKSPACE_ROOT',
      'createDbkWorkspaceSnapshot',
      'createFileMediaProvider',
      'createFileSystemDocumentTarget',
      'createSharedDocumentHash',
      'createSharedDocumentUrl',
      'decodeUtf8Text',
      'describeEntryMove',
      'describePartialMove',
      'deserializeFsError',
      'documentCompanionPath',
      'ensureDefaultWorkspace',
      'fsErrorFromUnknown',
      'getDefaultDocumentRecoveryStorage',
      'getDocBlocksHost',
      'getFileSystemProviderV2',
      'getTransientWorkspace',
      'getWorkspace',
      'hasFileSystemProviderV2',
      'isBoundedBytePayload',
      'isBoundedString',
      'isElectronHost',
      'isFileSystemMoveRecoveryError',
      'isFileSystemMoveStateError',
      'isFileSystemPartialMoveError',
      'isNativeFileSystemSupported',
      'isQuotaExceededError',
      'isSerializedFsError',
      'isTrustedRendererUrl',
      'listWorkspaces',
      'loadDirectoryHandle',
      'mapDomExceptionToFsErrorCode',
      'mapNodeErrorCodeToFsErrorCode',
      'maybeGetDocBlocksHost',
      'moveFileSystemEntry',
      'openNativeFolder',
      'parseExternalHttpUrl',
      'parseFileSystemVersion',
      'parseOpenRequest',
      'parsePersistedWorkspaceList',
      'parsePinnedMenuDocuments',
      'parseSharedDocumentHash',
      'parseWorkspacePath',
      'reconcileElectronWorkspaceDescriptors',
      'registerTransientWorkspace',
      'removeDirectoryHandle',
      'removeWorkspace',
      'replaceMemoryWorkspaceFromDbk',
      'restoreNativeFolder',
      'saveWorkspace',
      'serializeFsError',
      'storeDirectoryHandle',
      'touchWorkspace',
      'tryParseFileSystemVersion',
      'tryParseWorkspacePath',
      'unregisterTransientWorkspace',
      'workspacePathBasename',
      'workspacePathContains',
      'workspacePathDirname',
      'workspacePathJoin',
      'workspacePathToLegacy',
    ]);
  });

  describe('filesystem', () => {
    it('exports NativeFileSystemProvider class', () => {
      expect(NativeFileSystemProvider).to.be.a('function');
    });

    it('exports IndexedDBFileSystemProvider class', () => {
      expect(IndexedDBFileSystemProvider).to.be.a('function');
    });

    it('exports isolated memory and Electron provider entry points', () => {
      expect(MemoryFileSystemProvider).to.be.a('function');
      expect(ElectronFileSystemProvider).to.be.a('function');
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
      const file: FileEntry = {
        kind: 'file',
        name: 'readme.md',
        path: 'readme.md',
        lastModified: '2026-07-22T12:00:00.000Z',
      };
      const folder: FolderEntry = { kind: 'directory', name: 'docs', path: 'docs' };
      const entries: FileSystemEntry[] = [folder, file];

      expect(entries).to.have.length(2);
      expect(entries[0].kind).to.equal('directory');
      expect(entries[1].kind).to.equal('file');
      expect(file.lastModified).to.equal('2026-07-22T12:00:00.000Z');
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
