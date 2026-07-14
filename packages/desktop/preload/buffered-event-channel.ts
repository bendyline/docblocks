/**
 * Small preload-side event channel that closes the gap between an IPC event
 * arriving and the isolated renderer subscribing through contextBridge.
 */
export class BufferedEventChannel<T> {
  private readonly listeners = new Set<(value: T) => void>();
  private readonly pending: T[] = [];
  private draining = false;

  public constructor(
    private readonly maximumPending = 32,
    private readonly onListenerError: (error: unknown) => void = () => undefined,
    private readonly onEvict: (value: T) => void = () => undefined,
  ) {
    if (!Number.isInteger(maximumPending) || maximumPending < 1) {
      throw new RangeError('maximumPending must be a positive integer.');
    }
  }

  public publish(value: T): void {
    if (this.pending.length === this.maximumPending) {
      const evicted = this.pending.shift()!;
      try {
        this.onEvict(evicted);
      } catch {
        // Eviction cleanup is advisory; queue bounds and ordering still hold.
      }
    }
    this.pending.push(value);
    this.drain();
  }

  public subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);

    this.drain();

    return () => this.listeners.delete(listener);
  }

  private drain(): void {
    if (this.draining || this.listeners.size === 0) return;
    this.draining = true;
    try {
      while (this.pending.length > 0 && this.listeners.size > 0) {
        const value = this.pending.shift()!;
        for (const listener of [...this.listeners]) {
          try {
            listener(value);
          } catch (error: unknown) {
            // A renderer callback is outside the preload channel's authority.
            // Report it without starving later requests or other listeners.
            try {
              this.onListenerError(error);
            } catch {
              // Error reporting is advisory; delivery ordering remains authoritative.
            }
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
