const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_REQUEST_TIMEOUT_MS = 5 * 60_000;
const MAX_REQUEST_ID = 2_147_483_647;

export interface WebviewRequestRegistryOptions {
  label: string;
  maxPending: number;
  timeoutMs?: number;
}

interface PendingRequest<TResponse> {
  expectedType: string;
  resolve: (response: TResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Bounded request/response correlation for an untrusted postMessage bridge.
 * Every request either receives the expected response type, rejects on a
 * protocol mismatch, times out, or is rejected when its owner is disposed.
 */
export class WebviewRequestRegistry<TResponse extends { type: string }> {
  private readonly pending = new Map<number, PendingRequest<TResponse>>();
  private readonly label: string;
  private readonly maxPending: number;
  private readonly timeoutMs: number;
  private nextRequestId = 1;
  private disposed = false;

  public constructor(options: WebviewRequestRegistryOptions) {
    if (!Number.isSafeInteger(options.maxPending) || options.maxPending <= 0) {
      throw new Error('Webview request capacity must be a positive integer');
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      throw new Error('Webview request timeout must be between 1 ms and 5 minutes');
    }
    this.label = options.label;
    this.maxPending = options.maxPending;
    this.timeoutMs = timeoutMs;
  }

  public request<TType extends TResponse['type']>(
    expectedType: TType,
    send: (requestId: number) => void,
  ): Promise<Extract<TResponse, { type: TType }>> {
    if (this.disposed) return Promise.reject(new Error(`${this.label} bridge disposed`));
    if (this.pending.size >= this.maxPending) {
      return Promise.reject(new Error(`Too many pending ${this.label} requests`));
    }

    const requestId = this.allocateRequestId();
    return new Promise<Extract<TResponse, { type: TType }>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        reject(new Error(`${this.label} request timed out`));
      }, this.timeoutMs);
      this.pending.set(requestId, {
        expectedType,
        resolve: (response) => resolve(response as Extract<TResponse, { type: TType }>),
        reject,
        timeout,
      });
      try {
        send(requestId);
      } catch (error: unknown) {
        this.reject(requestId, toError(error));
      }
    });
  }

  public settle(requestId: number, response: TResponse): boolean {
    const request = this.pending.get(requestId);
    if (!request) return false;
    this.pending.delete(requestId);
    clearTimeout(request.timeout);
    if (request.expectedType !== response.type) {
      request.reject(
        new Error(
          `${this.label} protocol mismatch: expected ${request.expectedType}, received ${response.type}`,
        ),
      );
      return true;
    }
    request.resolve(response);
    return true;
  }

  public reject(requestId: number, error: Error): boolean {
    const request = this.pending.get(requestId);
    if (!request) return false;
    this.pending.delete(requestId);
    clearTimeout(request.timeout);
    request.reject(error);
    return true;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error(`${this.label} bridge disposed`));
    }
    this.pending.clear();
  }

  private allocateRequestId(): number {
    for (let attempts = 0; attempts < this.maxPending + 1; attempts += 1) {
      const candidate = this.nextRequestId;
      this.nextRequestId = candidate >= MAX_REQUEST_ID ? 1 : candidate + 1;
      if (!this.pending.has(candidate)) return candidate;
    }
    throw new Error(`Could not allocate a ${this.label} request ID`);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
