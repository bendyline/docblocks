import { expect } from 'chai';
import { parseConversionResult, parseMcpErrorResult } from '@bendyline/docblocks/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ArtifactStore } from '../src/mcp/artifact-store.js';
import { errorResult } from '../src/mcp/error-result.js';
import {
  OperationBusyError,
  OperationClosingError,
  OperationDrainTimeoutError,
  OperationGuard,
  OperationShutdownError,
  OperationTimeoutError,
  McpServerShutdownError,
  createMcpServer,
} from '../src/mcp/server.js';
import { reportMcpProgress } from '../src/mcp/progress.js';
import { callTool } from './mcp-helpers.js';

describe('MCP operation budgets and progress ordering', () => {
  it('rejects a pre-aborted request without scheduling work or consuming capacity', async () => {
    const guard = new OperationGuard(1, 1_000);
    const controller = new AbortController();
    const reason = new Error('request was already cancelled');
    controller.abort(reason);
    let workStarted = false;

    let caught: unknown;
    try {
      await guard.run(controller.signal, async () => {
        workStarted = true;
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).to.equal(reason);
    expect(workStarted).to.equal(false);
    expect(await guard.run(new AbortController().signal, async () => 'available')).to.equal(
      'available',
    );
  });

  it('aborts over-budget work, preserves the stable timeout, and releases capacity after cleanup', async () => {
    const guard = new OperationGuard(1, 20);
    let observedReason: unknown;
    let caught: unknown;
    try {
      await guard.run(new AbortController().signal, async (signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              observedReason = signal.reason;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(OperationTimeoutError);
    expect(observedReason).to.equal(caught);
    expect(caught).to.include({ code: 'timeout' });
    expect(await guard.run(new AbortController().signal, async () => 'released')).to.equal(
      'released',
    );
  });

  it('preserves a caller cancellation reason exactly', async () => {
    const guard = new OperationGuard(1, 1_000);
    const controller = new AbortController();
    const reason = new Error('caller-owned reason');
    const pending = guard.run(controller.signal, async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    controller.abort(reason);

    let caught: unknown;
    try {
      await pending;
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).to.equal(reason);
  });

  it('reports busy capacity as structured machine-readable load', async () => {
    const guard = new OperationGuard(1, 1_000);
    const gate = deferred<void>();
    const started = deferred<void>();
    const active = guard.run(new AbortController().signal, async () => {
      started.resolve();
      await gate.promise;
    });
    await started.promise;

    let caught: unknown;
    try {
      await guard.run(new AbortController().signal, async () => undefined);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(OperationBusyError);
    const parsed = parseMcpErrorResult(errorResult(caught).structuredContent);
    expect(parsed?.error).to.include({ code: 'busy', retryable: true });
    expect(parsed?.error.operationLoad).to.deep.equal({ active: 1, capacity: 1 });

    gate.resolve();
    await active;
  });

  it('aborts and drains active cleanup before shutdown and rejects new work', async () => {
    const guard = new OperationGuard(1, 1_000);
    const started = deferred<void>();
    const aborted = deferred<unknown>();
    const releaseCleanup = deferred<void>();
    const pending = guard.run(new AbortController().signal, async (signal) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted.resolve(signal.reason);
            resolve();
          },
          { once: true },
        );
      });
      await releaseCleanup.promise;
      throw signal.reason;
    });
    const pendingError = pending.catch((caught: unknown) => caught);
    await started.promise;

    let drained = false;
    const shutdown = guard.shutdown().then(() => {
      drained = true;
    });
    const reason = await aborted.promise;
    expect(reason).to.be.instanceOf(OperationShutdownError);
    await Promise.resolve();
    expect(drained).to.equal(false);

    releaseCleanup.resolve();
    await shutdown;
    expect(await pendingError).to.equal(reason);
    try {
      await guard.run(new AbortController().signal, async () => undefined);
      expect.fail('Expected a closing guard to reject new work');
    } catch (caught: unknown) {
      expect(caught).to.be.instanceOf(OperationClosingError);
    }
  });

  it('bounds shutdown drain time and can finish after delayed cleanup releases', async () => {
    const guard = new OperationGuard(1, 1_000, 20);
    const started = deferred<void>();
    const releaseCleanup = deferred<void>();
    const pending = guard.run(new AbortController().signal, async () => {
      started.resolve();
      await releaseCleanup.promise;
    });
    const pendingResult = pending.catch((caught: unknown) => caught);
    await started.promise;

    let caught: unknown;
    try {
      await guard.shutdown();
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(OperationDrainTimeoutError);

    releaseCleanup.resolve();
    await pendingResult;
    await guard.shutdown();
  });

  it('owns artifact cleanup when the peer closes its transport', async () => {
    const originalDispose = ArtifactStore.prototype.dispose;
    let disposeCount = 0;
    ArtifactStore.prototype.dispose = async function () {
      disposeCount += 1;
      await originalDispose.call(this);
    };
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'shutdown-peer-test', version: '0.0.0' });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      await client.close();
      for (let attempt = 0; attempt < 100 && disposeCount === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(disposeCount).to.equal(1);
      await server.close();
      expect(disposeCount).to.equal(1);
    } finally {
      ArtifactStore.prototype.dispose = originalDispose;
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it('disposes artifacts and preserves a drain timeout when a peer closes during non-cooperative work', async () => {
    const originalRead = ArtifactStore.prototype.read;
    const originalDispose = ArtifactStore.prototype.dispose;
    const originalShutdown = OperationGuard.prototype.shutdown;
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    const shutdownStarted = deferred<void>();
    let disposeCount = 0;
    ArtifactStore.prototype.read = async function (uriOrId) {
      readStarted.resolve();
      await releaseRead.promise;
      return originalRead.call(this, uriOrId);
    };
    ArtifactStore.prototype.dispose = async function () {
      disposeCount += 1;
      await originalDispose.call(this);
    };
    OperationGuard.prototype.shutdown = function () {
      const shutdown = originalShutdown.call(this);
      shutdownStarted.resolve();
      return shutdown;
    };

    const server = createMcpServer({ shutdownDrainTimeoutMs: 20 });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'shutdown-active-peer-test', version: '0.0.0' });
    let pendingRead: Promise<unknown> | null = null;
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const converted = await callTool(client, 'convert_document', {
        source: { kind: 'markdown', markdown: '# Held artifact', name: null },
        targets: [{ format: 'md', fidelity: 'semantic' }],
      });
      const candidates = converted.structuredContent?.results;
      const conversion = parseConversionResult(Array.isArray(candidates) ? candidates[0] : null);
      if (!conversion) throw new Error('Expected a canonical conversion artifact');

      pendingRead = callTool(client, 'inspect_document', {
        source: { kind: 'artifact', uri: conversion.artifact.uri },
      }).catch((caught: unknown) => caught);
      await readStarted.promise;

      const peerClose = client.close();
      await shutdownStarted.promise;
      let closeFailure: unknown;
      try {
        await server.close();
      } catch (caught: unknown) {
        closeFailure = caught;
      }
      await peerClose;

      expect(closeFailure).to.be.instanceOf(OperationDrainTimeoutError);
      expect(disposeCount).to.equal(1);
    } finally {
      releaseRead.resolve();
      await pendingRead;
      ArtifactStore.prototype.read = originalRead;
      ArtifactStore.prototype.dispose = originalDispose;
      OperationGuard.prototype.shutdown = originalShutdown;
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it('aggregates shutdown and cleanup failures without losing the primary cause', async () => {
    const originalShutdown = OperationGuard.prototype.shutdown;
    const originalDispose = ArtifactStore.prototype.dispose;
    const shutdownFailure = new Error('injected shutdown failure');
    const cleanupFailure = new Error('injected artifact cleanup failure');
    OperationGuard.prototype.shutdown = async function () {
      throw shutdownFailure;
    };
    ArtifactStore.prototype.dispose = async function () {
      await originalDispose.call(this);
      throw cleanupFailure;
    };

    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'shutdown-aggregate-test', version: '0.0.0' });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      let caught: unknown;
      try {
        await server.close();
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).to.be.instanceOf(McpServerShutdownError);
      expect((caught as McpServerShutdownError).cause).to.equal(shutdownFailure);
      expect((caught as McpServerShutdownError).errors).to.deep.equal([
        shutdownFailure,
        cleanupFailure,
      ]);
    } finally {
      OperationGuard.prototype.shutdown = originalShutdown;
      ArtifactStore.prototype.dispose = originalDispose;
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it('serializes concurrent producer notifications onto one monotonic percent scale', async () => {
    const observed: number[] = [];
    const extra = {
      _meta: { progressToken: 'progress' },
      async sendNotification(notification: {
        method: 'notifications/progress';
        params: {
          progressToken: string | number;
          progress: number;
          total: number;
          message: string;
        };
      }): Promise<void> {
        await Promise.resolve();
        expect(notification.params.total).to.equal(100);
        observed.push(notification.params.progress);
      },
    };

    await Promise.all([
      reportMcpProgress(extra, 8, 10, 'late phase'),
      reportMcpProgress(extra, 2, 10, 'stale callback'),
      reportMcpProgress(extra, 10, 10, 'complete'),
    ]);
    expect(observed).to.deep.equal([80, 80, 100]);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value?: T) => resolvePromise(value as T),
  };
}
