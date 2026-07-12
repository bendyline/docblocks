import type { WebviewToExtensionMessage } from '@bendyline/docblocks/vscode';

export type WebviewEditMessage = Extract<WebviewToExtensionMessage, { type: 'edit' }>;

export interface LatestDocumentEditQueueOptions {
  apply(message: WebviewEditMessage): Promise<void>;
  onError(error: unknown): void;
}

/**
 * One-slot ingress for complete webview document snapshots.
 *
 * Edits bypass the bounded privileged-operation queue. While the host is
 * delayed, newer snapshots replace older snapshots for the same branch. A
 * close boundary stops new ingress but always drains the snapshot that was
 * already accepted.
 */
export class LatestDocumentEditQueue {
  private pending: WebviewEditMessage | null = null;
  private drainPromise: Promise<void> = Promise.resolve();
  private running = false;
  private disposing = false;

  public constructor(private readonly options: LatestDocumentEditQueueOptions) {}

  public enqueue(message: WebviewEditMessage): boolean {
    if (this.disposing) return false;
    const pending = this.pending;
    if (
      pending &&
      pending.sessionId === message.sessionId &&
      pending.baseDocumentVersion === message.baseDocumentVersion &&
      pending.clientRevision >= message.clientRevision
    ) {
      return false;
    }
    this.pending = message;
    this.scheduleDrain();
    return true;
  }

  public beginDispose(): void {
    this.disposing = true;
  }

  public async flush(): Promise<void> {
    while (this.running || this.pending) {
      this.scheduleDrain();
      await this.drainPromise;
    }
  }

  private scheduleDrain(): void {
    if (this.running || !this.pending) return;
    this.running = true;
    this.drainPromise = this.drain()
      .catch((error: unknown) => this.options.onError(error))
      .finally(() => {
        this.running = false;
        if (this.pending) this.scheduleDrain();
      });
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const latest = this.pending;
      this.pending = null;
      await this.options.apply(latest);
    }
  }
}
