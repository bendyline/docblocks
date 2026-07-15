import { expect } from 'chai';
import type { WebviewToExtensionMessage } from '@bendyline/docblocks/vscode';
import { createVscodeExportBridge } from '../webview/src/vscodeExportBridge.js';
import { createVscodeMediaBridge } from '../webview/src/vscodeMediaProvider.js';

describe('VS Code webview request bridges', () => {
  it('times out an unanswered export request and releases its slot', async () => {
    const posted: WebviewToExtensionMessage[] = [];
    const bridge = createVscodeExportBridge(
      (message) => posted.push(message),
      () => '# document',
      () => 'document.md',
      { requestTimeoutMs: 5 },
    );
    try {
      const failure = await bridge.resolveExportTarget('document.pdf').then(
        () => null,
        (error: unknown) => error,
      );

      expect(posted).to.have.length(1);
      expect(failure).to.be.instanceOf(Error);
      expect((failure as Error).message).to.equal('VS Code export request timed out');
    } finally {
      bridge.dispose();
    }
  });

  it('rejects a response whose request ID is paired with the wrong message type', async () => {
    const posted: WebviewToExtensionMessage[] = [];
    const bridge = createVscodeExportBridge(
      (message) => posted.push(message),
      () => '# document',
      () => 'document.md',
      { requestTimeoutMs: 100 },
    );
    try {
      const pending = bridge.resolveExportTarget('document.pdf');
      const request = posted[0];
      if (!request) throw new Error('Expected an export request');
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'exportSaved', requestId: request.requestId, target: null },
        }),
      );

      const failure = await pending.then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).to.be.instanceOf(Error);
      expect((failure as Error).message).to.contain(
        'expected exportTargetResolved, received exportSaved',
      );
    } finally {
      bridge.dispose();
    }
  });

  it('accepts a validated opaque export target response', async () => {
    const posted: WebviewToExtensionMessage[] = [];
    const bridge = createVscodeExportBridge(
      (message) => posted.push(message),
      () => '# document',
      () => 'document.md',
      { requestTimeoutMs: 100 },
    );
    try {
      const pending = bridge.resolveExportTarget('document.pdf');
      const request = posted[0];
      if (!request) throw new Error('Expected an export request');
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'exportTargetResolved',
            requestId: request.requestId,
            target: { grantId: 'export_123', displayLabel: 'document.pdf' },
          },
        }),
      );

      expect(await pending).to.deep.equal({
        grantId: 'export_123',
        displayLabel: 'document.pdf',
      });
    } finally {
      bridge.dispose();
    }
  });

  it('times out an unanswered media request', async () => {
    const posted: WebviewToExtensionMessage[] = [];
    const bridge = createVscodeMediaBridge((message) => posted.push(message), {
      requestTimeoutMs: 5,
    });
    try {
      const failure = await bridge.mediaProvider.listMedia().then(
        () => null,
        (error: unknown) => error,
      );

      expect(posted).to.have.length(1);
      expect(failure).to.be.instanceOf(Error);
      expect((failure as Error).message).to.equal('VS Code media request timed out');
    } finally {
      bridge.dispose();
    }
  });

  it('blocks remote media without sending a tracking request', async () => {
    const posted: WebviewToExtensionMessage[] = [];
    const bridge = createVscodeMediaBridge((message) => posted.push(message));
    try {
      const failure = await bridge.mediaProvider
        .resolveUrl('https://tracker.example/pixel.png')
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(failure).to.be.instanceOf(Error);
      expect((failure as Error).message).to.contain('Remote media is blocked');
      expect(posted).to.deep.equal([]);
    } finally {
      bridge.dispose();
    }
  });
});
