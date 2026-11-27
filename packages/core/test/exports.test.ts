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
      'AI_IMAGE_ASPECTS',
      'AI_IMAGE_FIT_VERDICTS',
      'AI_IMAGE_WIRE_LIMITS',
      'AI_SUGGESTION_MIN_BYTES',
      'AI_WIRE_LIMITS',
      'CONFLICT_COPIES_DIRECTORY_NAME',
      'CONFLICT_COPIES_OTHER_DIRECTORY_NAME',
      'DEFAULT_WORKSPACE_ID',
      'DOCUMENT_LINEAGE_STORAGE_KEY',
      'DOCUMENT_RECOVERY_JOURNAL_SCHEMA_VERSION',
      'DOCUMENT_RECOVERY_JOURNAL_STORAGE_KEY',
      'DocumentCommitConflictError',
      'DocumentLineageStore',
      'DocumentRecoveryJournal',
      'DocumentSession',
      'DocumentSessionConflictError',
      'ELECTRON_FILE_SYSTEM_V2_CAPABILITIES',
      'EMBEDDINGS_WIRE_LIMITS',
      'EXPORT_TRANSFER_LIMITS',
      'ElectronFileSystemProvider',
      'ElectronFileSystemProviderV2',
      'FILE_SYSTEM_DIRECTORY_LIMITS',
      'FILE_SYSTEM_ENUMERATION_LIMITS',
      'FILE_SYSTEM_TRANSFER_LIMITS',
      'FileSystemContentContainer',
      'FileSystemMoveRecoveryError',
      'FileSystemPartialMoveError',
      'FsError',
      'HOST_PLATFORMS',
      'HOST_SURFACE_KINDS',
      'HOST_WIRE_LIMITS',
      'IndexedDBContentContainer',
      'IndexedDBFileSystemProvider',
      'IndexedDBFileSystemProviderV2',
      'LegacyFileSystemProviderV2Adapter',
      'MARKDOWN_FILE_EXTENSIONS',
      'MAX_HOST_PINNED_DOCUMENTS',
      'MemoryFileSystemProvider',
      'MemoryFileSystemProviderV2',
      'NOTIFICATION_LIMITS',
      'NO_HOST_CAPABILITIES',
      'NativeFileSystemMoveRecoveryError',
      'NativeFileSystemProvider',
      'NativeFileSystemProviderV2',
      'PREMERGE_COPY_LIFETIME_MS',
      'PREMERGE_COPY_LIMIT',
      'SHARED_DOCUMENT_LIMITS',
      'SPEECH_WIRE_LIMITS',
      'SQUISQ_RUNTIME_DIRECTORY_NAME',
      'SUPPORT_EMAIL_ADDRESS',
      'WORKSPACE_KNOWLEDGE_CATALOG_ID',
      'WORKSPACE_KNOWLEDGE_NAME',
      'WORKSPACE_METADATA_DIRECTORY_NAME',
      'WORKSPACE_ROOT',
      'aiDeviceFit',
      'buildChatCompletionBody',
      'conflictCopyHash',
      'conflictCopyScope',
      'createDbkWorkspaceSnapshot',
      'createFileMediaProvider',
      'createFileSystemDocumentTarget',
      'createSharedDocumentHash',
      'createSharedDocumentUrl',
      'decodeUtf8Text',
      'deriveHostCapabilities',
      'describeEntryMove',
      'describePartialMove',
      'deserializeFsError',
      'documentCompanionPath',
      'ensureDefaultWorkspace',
      'ensureWikiArticle',
      'findWikiArticle',
      'formatConflictCopyName',
      'fsErrorFromUnknown',
      'getDefaultDocumentRecoveryStorage',
      'getDocBlocksHost',
      'getFileSystemProviderV2',
      'getHostCapabilities',
      'getHostEnvironment',
      'getTransientWorkspace',
      'getWorkspace',
      'hasDocBlocksHost',
      'hasFileSystemProviderV2',
      'hostSupports',
      'imageEditCompanionPath',
      'isAiImageAspect',
      'isAiImageModelId',
      'isBoundedBytePayload',
      'isBoundedString',
      'isBrowsableWorkspaceEntry',
      'isCompanionDirectoryName',
      'isConflictCopyPath',
      'isDestinationFolderName',
      'isDiscoverableWorkspaceEntry',
      'isDocumentMediaPath',
      'isEditableImagePath',
      'isElectronHost',
      'isEnumeratedWorkspaceEntryName',
      'isFileSystemMoveRecoveryError',
      'isFileSystemMoveStateError',
      'isFileSystemPartialMoveError',
      'isIgnoredWorkspaceEntryName',
      'isLocalEngineModel',
      'isMarkdownFileName',
      'isNativeFileSystemSupported',
      'isQuotaExceededError',
      'isReviewableConflictCopy',
      'isSerializedFsError',
      'isSpeechModelId',
      'isTrustedRendererUrl',
      'knowledgeChatEvent',
      'knowledgeSources',
      'listConflictCopies',
      'listWorkspaces',
      'loadDirectoryHandle',
      'mapDomExceptionToFsErrorCode',
      'mapNodeErrorCodeToFsErrorCode',
      'maybeGetDocBlocksHost',
      'mergeText',
      'moveFileBetweenWorkspaces',
      'moveFileSystemEntry',
      'openNativeFolder',
      'parseAiChatEvent',
      'parseAiChatKnowledge',
      'parseAiChatProgress',
      'parseAiChatRequest',
      'parseAiDeviceFit',
      'parseAiError',
      'parseAiFactCheck',
      'parseAiFactCheckRequest',
      'parseAiImageAccess',
      'parseAiImageEvent',
      'parseAiImageInstallEvent',
      'parseAiImageModel',
      'parseAiImageModelList',
      'parseAiImagePreferences',
      'parseAiImagePreferencesPatch',
      'parseAiImageRequest',
      'parseAiImageResult',
      'parseAiImageStyle',
      'parseAiImageStyleList',
      'parseAiKnowledgeAction',
      'parseAiKnowledgeState',
      'parseAiModelDocbench',
      'parseAiModelDownloadInfo',
      'parseAiModelDownloadInfoList',
      'parseAiModelInfo',
      'parseAiModelInfoList',
      'parseAiModelInstallEvent',
      'parseAiPreferences',
      'parseAiPreferencesPatch',
      'parseAiProgress',
      'parseAiStatus',
      'parseAiWorkspacePassages',
      'parseBadgeCount',
      'parseConflictCopyName',
      'parseEmbeddingsRequest',
      'parseEmbeddingsStatus',
      'parseEmbeddingsTokenizer',
      'parseEmbeddingsVectors',
      'parseExternalHttpUrl',
      'parseFileSystemVersion',
      'parseHostEnvironment',
      'parseHostReminders',
      'parseNotificationPermission',
      'parseOpenExternalUrl',
      'parseOpenRequest',
      'parsePersistedWorkspaceList',
      'parsePinnedMenuDocuments',
      'parseSharedDocumentHash',
      'parseSpeechAudioChunk',
      'parseSpeechCatalog',
      'parseSpeechError',
      'parseSpeechInstallEvent',
      'parseSpeechModelInfo',
      'parseSpeechModelKind',
      'parseSpeechNullResult',
      'parseSpeechPreferences',
      'parseSpeechPreferencesPatch',
      'parseSpeechProgress',
      'parseSpeechReadiness',
      'parseSpeechResult',
      'parseSpeechStatus',
      'parseSpeechSynthesisSummary',
      'parseSpeechSynthesizeEvent',
      'parseSpeechSynthesizeRequest',
      'parseSpeechTranscribeRequest',
      'parseSpeechTranscript',
      'parseSpeechVoiceInfo',
      'parseSupportMailtoUrl',
      'parseWorkspacePassageUri',
      'parseWorkspacePath',
      'providerModelDocbench',
      'providerModelIsSystem',
      'providerModelRanking',
      'pruneConflictCopies',
      'publishFileSystemChangeHint',
      'readConflictCopy',
      'reconcileElectronWorkspaceDescriptors',
      'registerTransientWorkspace',
      'removeConflictCopy',
      'removeDirectoryHandle',
      'removeWorkspace',
      'replaceMemoryWorkspaceFromDbk',
      'resolveDocumentRelativeMediaPath',
      'resolveWikiArticlePath',
      'restoreNativeFolder',
      'rewriteCompanionReferences',
      'sanitizeConflictCopyLabel',
      'saveWorkspace',
      'serializeFsError',
      'sortModelDownloads',
      'storeDirectoryHandle',
      'subscribeFileSystemChangeHints',
      'suggestWikiArticles',
      'suggestsLocalAi',
      'touchWorkspace',
      'tryParseFileSystemVersion',
      'tryParseWorkspacePath',
      'unregisterTransientWorkspace',
      'wikiArticleExists',
      'withWorkspaceCatalogId',
      'workspacePassageUri',
      'workspacePathBasename',
      'workspacePathContains',
      'workspacePathDirname',
      'workspacePathJoin',
      'workspacePathToLegacy',
      'writeConflictCopy',
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
