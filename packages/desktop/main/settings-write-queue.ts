/** A serialized writer whose tail recovers after an individual write fails. */
export class SettingsWriteQueue<T> {
  private tail: Promise<void> = Promise.resolve();

  public constructor(private readonly write: (snapshot: T) => Promise<void>) {}

  public enqueue(snapshot: T): Promise<void> {
    const queued = this.tail.catch(() => undefined).then(() => this.write(snapshot));
    this.tail = queued;
    // Debounced callers intentionally do not await. Attaching a rejection
    // handler prevents an unhandled rejection while drain() still observes it.
    void queued.catch(() => undefined);
    return queued;
  }

  public drain(): Promise<void> {
    return this.tail;
  }
}
