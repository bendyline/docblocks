export type PendingOpenRequest =
  | { readonly kind: 'argv'; readonly argv: readonly string[] }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string };

/**
 * Retains launch requests received after single-instance lock acquisition but
 * before a BrowserWindow exists. A single ordered queue preserves OS arrival
 * precedence across argv, macOS open-file, and deep-link events.
 */
export class PendingOpenRequests {
  private readonly requests: PendingOpenRequest[] = [];

  public enqueueArgv(argv: readonly string[]): void {
    this.requests.push({ kind: 'argv', argv: [...argv] });
  }

  public enqueueFile(path: string): void {
    this.requests.push({ kind: 'file', path });
  }

  public enqueueUrl(url: string): void {
    this.requests.push({ kind: 'url', url });
  }

  /**
   * Deliver the current batch in FIFO order. One stale or otherwise invalid OS
   * request must not prevent later requests from reaching the renderer. The
   * caller may inspect the returned failures for diagnostics; failed requests
   * are consumed rather than retried indefinitely.
   */
  public drain(dispatch: (request: PendingOpenRequest) => void): readonly unknown[] {
    const failures: unknown[] = [];
    for (const request of this.requests.splice(0)) {
      try {
        dispatch(request);
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    return failures;
  }
}
