/**
 * Hand harper's engine to its worker without the worker ever fetching a
 * webview resource.
 *
 * harper.js lints in a dedicated `blob:` Web Worker, and that worker fetches
 * the WASM from whatever URL it is given. VS Code's webview service worker
 * only forwards resource requests to the extension host when it can map the
 * requesting client back to its webview through an `id` query parameter on
 * the client's URL. A `blob:` worker's URL has none, so on recent desktop
 * releases (observed on 1.142) the request is never forwarded and the service
 * worker answers it with `408 Request Timeout` after 30 seconds — for any
 * file, not just a large one. The engine then rejects with "HTTP status code
 * is not ok" and the editor shows "Proofing…" forever. The same fetch from the
 * page itself is served normally, and 1.85 and VS Code for the Web serve both.
 *
 * So the page fetches the binary once and republishes it as a `blob:` URL of
 * its own. Blob URLs are resolved by the browser, never by a service worker,
 * and a dedicated worker can read the blob URLs of the document that created
 * it. The webview CSP already allows `connect-src blob:` for exactly this.
 *
 * Only the full binary is republished. harper derives the slim sibling it
 * also tries to load by substituting the file name in the URL; a `blob:` URL
 * has no file name, so that optional step is skipped. Nothing in the full
 * flavor uses the slim glue, so linting is unchanged — and the worker no
 * longer downloads a second 15 MB binary it never calls into.
 */

/** The browser surface this module needs, injectable for tests. */
export interface ProofingEngineSourceEnvironment {
  fetch(url: string): Promise<Response>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface ProofingEngineSource {
  /**
   * The engine's `blob:` URL. The first call downloads the binary; later
   * calls share that download. A failed download is not cached, so the next
   * proofing attempt retries.
   */
  resolve(): Promise<string>;
  /** Release the blob. Later `resolve` calls reject. */
  dispose(): void;
}

/** `WebAssembly.instantiateStreaming` refuses any other content type. */
const WASM_MIME_TYPE = 'application/wasm';

function browserEnvironment(): ProofingEngineSourceEnvironment {
  return {
    fetch: (url) => fetch(url),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  };
}

export function createProofingEngineSource(
  wasmUrl: string,
  environment: ProofingEngineSourceEnvironment = browserEnvironment(),
): ProofingEngineSource {
  let pending: Promise<string> | null = null;
  let objectUrl: string | null = null;
  let disposed = false;

  async function download(): Promise<string> {
    const response = await environment.fetch(wasmUrl);
    if (!response.ok) {
      throw new Error(`Could not load the proofing engine (HTTP ${response.status})`);
    }
    const fetched = await response.blob();
    // Re-type rather than trust the served header, which the engine's
    // streaming compile insists on. `slice` shares the bytes; it does not copy.
    const wasm =
      fetched.type === WASM_MIME_TYPE ? fetched : fetched.slice(0, fetched.size, WASM_MIME_TYPE);
    if (disposed) throw new Error('Proofing engine source has been disposed');
    objectUrl = environment.createObjectURL(wasm);
    return objectUrl;
  }

  return {
    resolve(): Promise<string> {
      if (disposed) return Promise.reject(new Error('Proofing engine source has been disposed'));
      pending ??= download().catch((error: unknown) => {
        pending = null;
        throw error;
      });
      return pending;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      pending = null;
      if (objectUrl) environment.revokeObjectURL(objectUrl);
      objectUrl = null;
    },
  };
}
