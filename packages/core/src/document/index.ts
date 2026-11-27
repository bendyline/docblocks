export {
  DocumentCommitConflictError,
  DocumentSession,
  DocumentSessionConflictError,
} from './document-session.js';
export {
  createFileSystemDocumentTarget,
  type FileSystemDocumentTargetOptions,
} from './filesystem-target.js';
export {
  DOCUMENT_RECOVERY_JOURNAL_SCHEMA_VERSION,
  DOCUMENT_RECOVERY_JOURNAL_STORAGE_KEY,
  DocumentRecoveryJournal,
  getDefaultDocumentRecoveryStorage,
} from './recovery-journal.js';
export {
  DOCUMENT_LINEAGE_STORAGE_KEY,
  DocumentLineageStore,
  type DocumentLineageStoreOptions,
} from './lineage-store.js';
export type { DocumentLineageRecord } from './lineage.js';
export { mergeText, type ThreeWayMergeResult } from './three-way-merge.js';
export type {
  DocumentAbsorbResult,
  DocumentAutoSavePacing,
  DocumentCommitRequest,
  DocumentCommitResult,
  DocumentCommitTarget,
  DocumentConflictResolution,
  DocumentConcurrentVersion,
  DocumentConflictStrategy,
  DocumentExternalChangeResult,
  DocumentExternalOrigin,
  DocumentExternalSnapshot,
  DocumentLineageStorage,
  DocumentParkOrigin,
  DocumentParkRequest,
  DocumentSessionEvent,
  DocumentSessionEventListener,
  DocumentExternalVersion,
  DocumentSaveReason,
  DocumentSessionConflict,
  DocumentSessionEditScope,
  DocumentSessionLifecycle,
  DocumentSessionOptions,
  DocumentSessionSnapshot,
  DocumentSessionStatus,
  DocumentSessionTransition,
} from './types.js';
export type {
  DocumentRecoveryAcknowledgement,
  DocumentRecoveryJournalOptions,
  DocumentRecoveryRecord,
  DocumentRecoveryStorage,
  DocumentRecoveryWrite,
  DocumentRecoveryWriteFailure,
  DocumentRecoveryWriteResult,
} from './recovery-journal.js';
