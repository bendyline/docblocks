import {
  DocumentRecoveryJournal,
  type DocumentRecoveryJournalOptions,
  type DocumentRecoveryStorage,
} from '@bendyline/docblocks/document';

const RECOVERY_TARGET_KEY = 'docblocks:vscode-webview-document';
const RECOVERY_STATE_PROPERTY = 'docblocksRecoveryJournal';

export interface VscodeWebviewStateApi {
  getState(): unknown;
  setState(state: unknown): void;
}

export type VscodeRecoveryStart =
  | { kind: 'clean' }
  | { kind: 'restore'; content: string }
  | { kind: 'conflict'; content: string };

interface PendingAcknowledgement {
  clientRevision: number;
  sessionRevision: number;
  content: string;
}

/**
 * Bounded synchronous recovery for the snapshot that has left the editor but
 * has not yet been durably acknowledged by VS Code.
 *
 * VS Code owns the backing webview state across renderer disposal/recreation.
 * The shared journal owns validation, age/size limits, and exact-baseline
 * recovery. A changed durable baseline is returned as an explicit conflict;
 * it is never overwritten automatically.
 */
export class VscodeWebviewRecovery {
  private readonly journal: DocumentRecoveryJournal;
  private generation = 0;
  private persistedContent = '';
  private pendingAcknowledgement: PendingAcknowledgement | null = null;

  public constructor(api: VscodeWebviewStateApi, options: DocumentRecoveryJournalOptions = {}) {
    this.journal = new DocumentRecoveryJournal(createRecoveryStorage(api), {
      maxEntries: 1,
      ...options,
    });
  }

  /** Start a host session, optionally considering state from a prior renderer. */
  public beginSession(
    persistedContent: string,
    recoverPriorRenderer: boolean,
  ): VscodeRecoveryStart {
    const record = this.journal.lookup(RECOVERY_TARGET_KEY);
    this.generation = Math.max(this.generation + 1, (record?.generation ?? 0) + 1);
    this.persistedContent = persistedContent;
    this.pendingAcknowledgement = null;

    if (!recoverPriorRenderer) {
      this.journal.discard(RECOVERY_TARGET_KEY);
      return { kind: 'clean' };
    }
    if (!record || record.content === persistedContent) {
      if (record) this.journal.discard(RECOVERY_TARGET_KEY, record.generation);
      return { kind: 'clean' };
    }
    if (record.persistedContent === persistedContent) {
      return { kind: 'restore', content: record.content };
    }
    return { kind: 'conflict', content: record.content };
  }

  /** Record a complete webview snapshot before posting it to the extension. */
  public recordEdit(clientRevision: number, content: string): boolean {
    const result = this.journal.write({
      targetKey: RECOVERY_TARGET_KEY,
      generation: this.generation,
      revision: clientRevision,
      content,
      persistedContent: this.persistedContent,
    });
    if (result.status === 'rejected') {
      // Do not retain an older draft after a newer snapshot could not be
      // journaled; that would offer stale recovery on the next renderer boot.
      this.journal.discard(RECOVERY_TARGET_KEY);
      return false;
    }
    return true;
  }

  /** Pair the latest journaled client snapshot with its host session revision. */
  public acknowledgeEdit(clientRevision: number, sessionRevision: number): void {
    const record = this.journal.lookup(RECOVERY_TARGET_KEY, this.generation);
    if (!record || record.revision !== clientRevision) return;
    this.pendingAcknowledgement = {
      clientRevision,
      sessionRevision,
      content: record.content,
    };
  }

  /** Remove recovery only after the corresponding session revision is durable. */
  public acknowledgePersisted(persistedSessionRevision: number): boolean {
    const pending = this.pendingAcknowledgement;
    if (!pending || pending.sessionRevision > persistedSessionRevision) return false;
    const removed = this.journal.acknowledge({
      targetKey: RECOVERY_TARGET_KEY,
      generation: this.generation,
      persistedRevision: pending.clientRevision,
    });
    if (removed) this.persistedContent = pending.content;
    this.pendingAcknowledgement = null;
    return removed;
  }

  public discard(): void {
    this.journal.discard(RECOVERY_TARGET_KEY);
    this.pendingAcknowledgement = null;
  }
}

function createRecoveryStorage(api: VscodeWebviewStateApi): DocumentRecoveryStorage {
  return {
    getItem(key) {
      const state = api.getState();
      if (!isRecord(state) || state.key !== key) return null;
      return typeof state[RECOVERY_STATE_PROPERTY] === 'string'
        ? state[RECOVERY_STATE_PROPERTY]
        : null;
    },
    setItem(key, value) {
      api.setState({ key, [RECOVERY_STATE_PROPERTY]: value });
    },
    removeItem(key) {
      const state = api.getState();
      if (isRecord(state) && state.key === key) api.setState({});
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
