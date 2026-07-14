import { useState, useSyncExternalStore } from 'react';
import {
  DocumentRecoveryJournal,
  DocumentSession,
  getDefaultDocumentRecoveryStorage,
  type DocumentSessionSnapshot,
} from '@bendyline/docblocks/document';

export interface UseDocumentSessionResult {
  /** Stable controller for the lifetime of the mounted shell/panel. */
  session: DocumentSession;
  /** React snapshot of dirty/saving/saved/error/conflict state. */
  snapshot: DocumentSessionSnapshot;
}

/**
 * React binding for the framework-neutral DocumentSession engine.
 *
 * The hook deliberately does not infer target transitions from props.
 * Callers must use transitionTo(), retarget(), or delete() before changing
 * their view state so persistence ordering remains explicit.
 */
export function useDocumentSession(autoSaveDelayMs = 500): UseDocumentSessionResult {
  const [session] = useState(
    () =>
      new DocumentSession({
        autoSaveDelayMs,
        recoveryJournal: new DocumentRecoveryJournal(getDefaultDocumentRecoveryStorage()),
      }),
  );
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  return { session, snapshot };
}
