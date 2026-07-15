export interface PwaState {
  /** A new deploy is waiting; applying it reloads onto the new version. */
  updateAvailable: boolean;
  /** First-time precache finished; the full app now works offline. */
  offlineReady: boolean;
  /** A first install could not cache the application for offline use. */
  installError: string | null;
}

type PwaListener = () => void;

const INITIAL_PWA_STATE: PwaState = Object.freeze({
  updateAvailable: false,
  offlineReady: false,
  installError: null,
});

/** Small observable store kept separate from the virtual PWA registration module for testing. */
export class PwaStateStore {
  private state: PwaState = INITIAL_PWA_STATE;
  private readonly listeners = new Set<PwaListener>();

  public subscribe = (listener: PwaListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public getSnapshot = (): PwaState => this.state;

  public markUpdateAvailable(): void {
    this.setState({ updateAvailable: true });
  }

  public markOfflineReady(): void {
    this.setState({ offlineReady: true, installError: null });
  }

  public markInstallFailed(): void {
    this.setState({
      offlineReady: false,
      installError:
        'DocBlocks could not finish caching the app for offline use. ' +
        'The online editor still works; free some browser storage and reload to try again.',
    });
  }

  private setState(patch: Partial<PwaState>): void {
    const next = { ...this.state, ...patch };
    if (
      next.updateAvailable === this.state.updateAvailable &&
      next.offlineReady === this.state.offlineReady &&
      next.installError === this.state.installError
    ) {
      return;
    }
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
