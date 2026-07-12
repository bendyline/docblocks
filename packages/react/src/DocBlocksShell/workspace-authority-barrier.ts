/**
 * Renderer-side barrier for main-authoritative Electron workspace identity.
 * OS requests may arrive before IndexedDB descriptors have been reconciled;
 * they must retain navigation priority while waiting for that reconciliation.
 */
export class WorkspaceAuthorityBarrier {
  private ready = false;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;

  public constructor() {
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  public markReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.resolveReady();
  }

  public wait(): Promise<void> {
    return this.readyPromise;
  }
}
