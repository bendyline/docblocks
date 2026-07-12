import type { WebviewToExtensionMessage } from '@bendyline/docblocks/vscode';

export interface EditorMessageQueueOptions<TMessage> {
  maxPendingOperations: number;
  maxPendingWireCharacters: number;
  estimateWireCharacters(message: TMessage): number;
  drainAfterDispose(message: TMessage): boolean;
  onError(error: unknown): void;
}

/**
 * Serialized, bounded panel message queue with an explicit close boundary.
 * Messages accepted before disposal retain their ordering. Document lifecycle
 * messages drain so close observes the latest edit; queued privileged work is
 * dropped once its owning panel and grants have been revoked.
 */
export class EditorMessageQueue<TMessage> {
  private tail: Promise<void> = Promise.resolve();
  private pendingOperationCount = 0;
  private pendingWireCharacters = 0;
  private disposing = false;

  public constructor(private readonly options: EditorMessageQueueOptions<TMessage>) {
    if (
      !Number.isSafeInteger(options.maxPendingOperations) ||
      options.maxPendingOperations <= 0 ||
      !Number.isSafeInteger(options.maxPendingWireCharacters) ||
      options.maxPendingWireCharacters <= 0
    ) {
      throw new Error('Editor message queue limits must be positive integers');
    }
  }

  public enqueue(message: TMessage, operation: () => Promise<void>): boolean {
    if (this.disposing) return false;
    const wireCharacters = this.options.estimateWireCharacters(message);
    if (
      !Number.isSafeInteger(wireCharacters) ||
      wireCharacters < 0 ||
      this.pendingOperationCount >= this.options.maxPendingOperations ||
      wireCharacters > this.options.maxPendingWireCharacters - this.pendingWireCharacters
    ) {
      return false;
    }

    this.pendingOperationCount += 1;
    this.pendingWireCharacters += wireCharacters;
    this.tail = this.tail
      .then(async () => {
        if (this.disposing && !this.options.drainAfterDispose(message)) return;
        await operation();
      })
      .catch((error: unknown) => this.options.onError(error))
      .finally(() => {
        this.pendingOperationCount -= 1;
        this.pendingWireCharacters -= wireCharacters;
      })
      .then(() => undefined);
    return true;
  }

  public beginDispose(): void {
    this.disposing = true;
  }

  public drain(): Promise<void> {
    return this.tail;
  }
}

export function drainsAfterPanelDispose(message: WebviewToExtensionMessage): boolean {
  return message.type === 'edit' || message.type === 'save' || message.type === 'resolveConflict';
}
