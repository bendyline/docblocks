import { expect } from 'chai';
import { DocumentService } from '../src/mcp/document-service.js';
import { callTool, startMcpHarness } from './mcp-helpers.js';

describe('MCP protocol cancellation', function () {
  this.timeout(10_000);

  it('propagates Client.callTool aborts through server cleanup and releases the operation slot', async () => {
    const harness = await startMcpHarness({ maxConcurrentOperations: 1 });
    const originalPrepare = DocumentService.prototype.prepare;
    const started = deferred<AbortSignal>();
    const serverAbort = deferred<unknown>();
    const allowCleanup = deferred<void>();
    const cleanupFinished = deferred<void>();
    let didFinishCleanup = false;

    DocumentService.prototype.prepare = async function (_source, signal) {
      if (!signal) throw new Error('Expected the MCP operation signal');
      started.resolve(signal);
      return new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => {
          serverAbort.resolve(signal.reason);
          void allowCleanup.promise.then(() => {
            signal.removeEventListener('abort', onAbort);
            didFinishCleanup = true;
            reject(signal.reason ?? new Error('MCP operation was cancelled'));
            queueMicrotask(cleanupFinished.resolve);
          });
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    };

    const controller = new AbortController();
    const reason = new Error('integration caller cancelled the MCP request');
    try {
      const pending = harness.client.callTool(
        {
          name: 'inspect_document',
          arguments: {
            source: { kind: 'markdown', markdown: '# Blocking operation', name: null },
          },
        },
        undefined,
        { signal: controller.signal, timeout: 5_000 },
      );

      const operationSignal = await within(started.promise, 'server operation start');
      expect(operationSignal.aborted).to.equal(false);
      controller.abort(reason);

      let callerError: unknown;
      try {
        await pending;
      } catch (caught: unknown) {
        callerError = caught;
      }
      expect(callerError).to.be.instanceof(Error);
      expect((callerError as Error).message).to.contain(reason.message);

      const serverReason = await within(serverAbort.promise, 'server cancellation notification');
      expect(operationSignal.aborted).to.equal(true);
      expect(serverReason).to.equal(String(reason));
      expect(didFinishCleanup).to.equal(false);

      allowCleanup.resolve();
      await within(cleanupFinished.promise, 'server operation cleanup');
      expect(didFinishCleanup).to.equal(true);
      DocumentService.prototype.prepare = originalPrepare;

      const subsequent = await callTool(harness.client, 'inspect_document', {
        source: { kind: 'markdown', markdown: '# Server remains usable', name: null },
      });
      expect(subsequent.isError).to.equal(false);
      expect(subsequent.structuredContent?.kind).to.equal('inspection');
    } finally {
      DocumentService.prototype.prepare = originalPrepare;
      if (!controller.signal.aborted) controller.abort(reason);
      allowCleanup.resolve();
      await harness.dispose();
    }
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 2_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
