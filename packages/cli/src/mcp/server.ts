import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { getPackageVersion } from '../version.js';
import {
  registerAgenticTools,
  MCP_CONVERSION_TARGET_FORMATS,
  MCP_FORMAT_CAPABILITIES,
} from './agentic-tools.js';
import { ArtifactStore, type ArtifactStoreOptions } from './artifact-store.js';
import { McpFileAuthority, type McpFileAuthorityOptions } from './authority.js';
import { registerDiscoveryTools } from './discovery-tools.js';
import { registerAuthoringPrompts } from './prompts.js';

const DEFAULT_MAX_CONCURRENT_OPERATIONS = 2;
const DEFAULT_OPERATION_TIMEOUT_MS = 2 * 60 * 1_000;
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

export interface McpServerOptions extends McpFileAuthorityOptions, ArtifactStoreOptions {
  maxConcurrentOperations?: number;
  operationTimeoutMs?: number;
  /** Bound cleanup latency after shutdown has aborted every active operation. */
  shutdownDrainTimeoutMs?: number;
}

/** Bounds expensive work while preserving the exact caller cancellation reason. */
export class OperationGuard {
  private active = 0;
  private accepting = true;
  private readonly controllers = new Set<AbortController>();
  private readonly completions = new Set<Promise<unknown>>();
  private shutdownPromise: Promise<void> | null = null;

  public constructor(
    private readonly maximum: number,
    private readonly timeoutMs: number,
    private readonly shutdownDrainTimeoutMs = DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
  ) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32) {
      throw new Error('Invalid MCP operation concurrency limit');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30 * 60 * 1_000) {
      throw new Error('Invalid MCP operation timeout');
    }
    if (
      !Number.isSafeInteger(shutdownDrainTimeoutMs) ||
      shutdownDrainTimeoutMs < 10 ||
      shutdownDrainTimeoutMs > 60_000
    ) {
      throw new Error('Invalid MCP shutdown drain timeout');
    }
  }

  public async run<T>(
    requestSignal: AbortSignal,
    work: (operationSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    requestSignal.throwIfAborted();
    if (!this.accepting) throw new OperationClosingError();
    if (this.active >= this.maximum) {
      throw new OperationBusyError(this.active, this.maximum);
    }
    this.active += 1;
    const controller = new AbortController();
    this.controllers.add(controller);
    const forwardCancellation = (): void => controller.abort(requestSignal.reason);
    if (requestSignal.aborted) forwardCancellation();
    else requestSignal.addEventListener('abort', forwardCancellation, { once: true });
    const timer = setTimeout(
      () => controller.abort(new OperationTimeoutError(this.timeoutMs)),
      this.timeoutMs,
    );
    let rejectAborted: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = (): void =>
        reject(controller.signal.reason ?? new Error('MCP operation was cancelled'));
      if (controller.signal.aborted) rejectAborted();
      else controller.signal.addEventListener('abort', rejectAborted, { once: true });
    });
    const completion: Promise<T> = Promise.resolve()
      .then(() => work(controller.signal))
      .finally(() => {
        clearTimeout(timer);
        requestSignal.removeEventListener('abort', forwardCancellation);
        controller.signal.removeEventListener('abort', rejectAborted);
        this.controllers.delete(controller);
        this.completions.delete(completion);
        this.active -= 1;
      });
    this.completions.add(completion);

    try {
      return await Promise.race([completion, aborted]);
    } catch (caught: unknown) {
      if (controller.signal.aborted) {
        // Give abort-aware work a turn to release resources. Work that ignores
        // cancellation still occupies its slot without delaying the response.
        await Promise.race([
          completion.then(
            () => undefined,
            () => undefined,
          ),
          new Promise<void>((resolve) => setTimeout(resolve, 0)),
        ]);
        throw controller.signal.reason ?? caught;
      }
      throw caught;
    }
  }

  /** Stop admission, abort active work, and wait for all operation cleanup before disposal. */
  public shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.accepting = false;
    const attempt = this.drain();
    this.shutdownPromise = attempt.catch((caught: unknown) => {
      this.shutdownPromise = null;
      throw caught;
    });
    return this.shutdownPromise;
  }

  private async drain(): Promise<void> {
    const reason = new OperationShutdownError();
    for (const controller of this.controllers) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
    if (this.completions.size === 0) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new OperationDrainTimeoutError(this.shutdownDrainTimeoutMs)),
        this.shutdownDrainTimeoutMs,
      );
    });
    try {
      await Promise.race([
        Promise.allSettled([...this.completions]).then(() => undefined),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export class OperationTimeoutError extends Error {
  public readonly code = 'timeout';
  public readonly hint: string;

  public constructor(timeoutMs: number) {
    super(`MCP operation exceeded its ${timeoutMs} ms runtime budget`);
    this.name = 'OperationTimeoutError';
    this.hint = 'Retry with fewer targets/items or increase the server operation timeout.';
  }
}

export class OperationBusyError extends Error {
  public readonly code = 'busy';
  public readonly hint: string;
  public readonly retryable = true;

  public constructor(
    public readonly active: number,
    public readonly capacity: number,
  ) {
    super(
      `MCP server is busy; retry later (${active} of ${capacity} expensive-operation slots are active)`,
    );
    this.name = 'OperationBusyError';
    this.hint =
      'Retry after one active operation completes; reducing target or preview count may help.';
  }
}

export class OperationClosingError extends Error {
  public readonly code = 'server-closing';
  public readonly hint = 'Reconnect to a running DocBlocks MCP server before retrying.';
  public readonly retryable = true;

  public constructor() {
    super('MCP server is closing and is not accepting new operations');
    this.name = 'OperationClosingError';
  }
}

export class OperationShutdownError extends Error {
  public readonly code = 'server-shutdown';
  public readonly hint = 'Reconnect to a running DocBlocks MCP server before retrying.';
  public readonly retryable = true;

  public constructor() {
    super('MCP operation was cancelled because the server is shutting down');
    this.name = 'OperationShutdownError';
  }
}

export class OperationDrainTimeoutError extends Error {
  public readonly code = 'shutdown-drain-timeout';
  public readonly hint = 'Wait for active converter cleanup, then close the server again.';
  public readonly retryable = true;

  public constructor(timeoutMs: number) {
    super(`MCP operations did not finish cleanup within ${timeoutMs} ms`);
    this.name = 'OperationDrainTimeoutError';
  }
}

/** Retains every independent failure encountered while closing the server. */
export class McpServerShutdownError extends Error {
  public readonly errors: readonly unknown[];
  public readonly cause: unknown;

  public constructor(errors: readonly unknown[]) {
    super(`MCP server shutdown encountered ${errors.length} failures`);
    this.name = 'McpServerShutdownError';
    this.errors = Object.freeze([...errors]);
    this.cause = this.errors[0];
  }
}

export type McpToolRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const authority = McpFileAuthority.create(options);
  // `createMcpServer` remains synchronous for SDK ergonomics, but root
  // resolution is asynchronous. Attach a handler immediately so an invalid
  // startup grant cannot become an unhandled rejection before connect(), then
  // make transport admission wait for every startup prerequisite.
  void authority.catch(() => undefined);
  const operations = new OperationGuard(
    options.maxConcurrentOperations ?? DEFAULT_MAX_CONCURRENT_OPERATIONS,
    options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    options.shutdownDrainTimeoutMs ?? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
  );
  const artifacts = new ArtifactStore(options);
  const server = new McpServer({ name: 'docblocks', version: getPackageVersion() });

  registerAgenticTools(server, {
    authority,
    artifacts,
    runOperation: (signal, work) => operations.run(signal, work),
  });
  registerDiscoveryTools(server);
  registerAuthoringPrompts(server);

  const connectServer = server.connect.bind(server);
  server.connect = async (transport) => {
    await Promise.all([authority, artifacts.ready()]);
    await connectServer(transport);
  };
  const closeServer = server.close.bind(server);
  let closePromise: Promise<void> | null = null;
  const beginShutdown = (closeTransport: boolean): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const failures: unknown[] = [];
      try {
        await operations.shutdown();
      } catch (caught: unknown) {
        failures.push(caught);
      }
      if (closeTransport) {
        try {
          await closeServer();
        } catch (caught: unknown) {
          failures.push(caught);
        }
      }
      try {
        await artifacts.dispose();
      } catch (caught: unknown) {
        failures.push(caught);
      }
      throwShutdownFailures(failures);
    })().catch((caught: unknown) => {
      closePromise = null;
      throw caught;
    });
    return closePromise;
  };
  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    previousOnClose?.();
    void beginShutdown(false).catch(() => undefined);
  };
  server.close = () => beginShutdown(true);
  return server;
}

function throwShutdownFailures(failures: readonly unknown[]): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new McpServerShutdownError(failures);
}

export { MCP_CONVERSION_TARGET_FORMATS, MCP_FORMAT_CAPABILITIES };
